import { expect, test, type Page } from "@playwright/test"

import { setFaults } from "./support/fixture-page"

/**
 * Platform-physics regression tests (UNN-682). The package's design rests on
 * these React 19 / Next 16 facts, established here against the real runtime
 * via /probe (raw `useOptimistic` + `startTransition` + the generated Server
 * Action — no headcanon client code). If a React or Next upgrade changes any
 * of these, the package's settlement model must be revisited before trusting
 * green tests.
 *
 * 1. A Server Action's revalidated RSC payload is PARKED while any optimistic
 *    Action is held open — regardless of where the send was invoked. The
 *    root relies on this: it holds an Action per delivery attempt so canon
 *    cannot commit before the attempt's acceptance is recorded.
 * 2. The parked payload commits atomically with Action settlement: there is
 *    no intermediate frame showing canon without the prediction.
 * 3. A held-open Action blocks router navigation entirely. This is why the
 *    root bounds each hold by `DELIVERY_WAIT_MS`.
 * 4. A pending Server Action call holds every transition until it responds,
 *    even with no Action open. So that bound frees the root's own hold but
 *    not the app: a Server Action that never answers still freezes it. The
 *    mechanism is Next's, not React's Action entanglement: `callServer`
 *    (next/dist/client/app-call-server.js) dispatches the call to the App
 *    Router's action queue, whose `dispatchAction`
 *    (next/dist/client/components/app-router-instance.js) sets the router
 *    state to a pending promise inside `startTransition`; `useActionQueue`
 *    reads that state with `use()`, so the router suspends in a transition
 *    lane. React renders every pending transition lane as one batch, so no
 *    transition commits until the call answers. The package cannot end that
 *    hold: Next's `fetch` for the call takes no abort signal.
 *    docs/server-setup.md#bound-database-and-network-waits tells adopters to
 *    bound it on the server instead.
 * 5. The same queue is serial: a second Server Action call is not sent while
 *    the first is unanswered, so a `retryDelivery()` waits too. A navigation
 *    is not held: Next discards the pending call's router update and
 *    navigates at once.
 */

/**
 * One DOM mutation's view of the probe: the optimistic frame and the canon
 * revision.
 */
interface Snapshot {
  readonly frame: string
  readonly revision: string
}

async function openProbe(page: Page): Promise<void> {
  await page.request.post("/api/reset")
  await page.goto("/probe")
}

test("a Server Action payload parks behind an open Action and flushes atomically", async ({
  page,
}) => {
  await openProbe(page)

  await page.getByRole("button", { name: "mutate inside" }).click()
  // Deterministic observation point: the action's response has been processed
  // (acceptance logged) while its owning Action is still held open.
  await expect(page.getByTestId("log")).toContainText("accepted rev=1")
  await expect(page.getByTestId("frame")).toHaveText("inside-1")
  // Snapshot, not poll: the payload must NOT have committed.
  expect(await page.getByTestId("revision").textContent()).toBe("0")

  // Record every intermediate frame across the flush; the prediction must
  // never disappear while the old canon is still rendered.
  await page.evaluate(() => {
    const snapshots: Snapshot[] = []
    const read = (testId: string) =>
      document.querySelector(`[data-testid="${testId}"]`)?.textContent ?? ""
    const observer = new MutationObserver(() => {
      snapshots.push({ frame: read("frame"), revision: read("revision") })
    })
    observer.observe(document.querySelector("main")!, {
      subtree: true,
      childList: true,
      characterData: true,
    })
    ;(window as unknown as { __snapshots: Snapshot[] }).__snapshots = snapshots
  })

  await page.getByRole("button", { name: "release all" }).click()
  await expect(page.getByTestId("revision")).toHaveText("1")
  await expect(page.getByTestId("frame")).toHaveText("inside-1")

  const snapshots = await page.evaluate(
    () => (window as unknown as { __snapshots: Snapshot[] }).__snapshots
  )
  // Non-vacuity: the flush must have produced observable commits (at minimum
  // the revision text change), or the atomicity loop below proves nothing.
  expect(snapshots.length).toBeGreaterThan(0)
  for (const snapshot of snapshots) {
    expect(snapshot.frame).toContain("inside-1")
  }
})

test("navigation is blocked while an Action is held open and proceeds on settlement", async ({
  page,
}) => {
  await openProbe(page)

  await page.getByRole("button", { name: "mutate inside" }).click()
  await expect(page.getByTestId("log")).toContainText("accepted rev=1")

  await page.getByRole("link", { name: "go home" }).click()
  // Proving a navigation does *not* happen needs a bounded wait: no event
  // signals "still blocked". A local client-side navigation commits in tens
  // of milliseconds, so one second is well past the point it would have.
  await page.waitForTimeout(1_000)
  expect(new URL(page.url()).pathname).toBe("/probe")

  await page.getByRole("button", { name: "release all" }).click()
  await expect(page).toHaveURL("/")
})

// Pinned, not fixed: the hold is the App Router action queue's pending
// router state (fact 4 above), which the package cannot abort.
test("a pending Server Action call holds every transition until it responds, with no Action open", async ({
  page,
}) => {
  await openProbe(page)
  // Control: with nothing pending, a transition commits at once.
  await page.getByRole("button", { name: "bump in a transition" }).click()
  await expect(page.getByTestId("bumps")).toHaveText("1")

  await setFaults(page, { delivery: "hang" })
  await page.getByRole("button", { name: "send bare" }).click()
  await page.getByRole("button", { name: "bump in a transition" }).click()
  // Bounded wait, as above: a transition commits in milliseconds.
  await page.waitForTimeout(1_000)
  expect(await page.getByTestId("bumps").textContent()).toBe("1")

  await setFaults(page, {})
  await expect(page.getByTestId("log")).toContainText("bare:bare-1 accepted")
  await expect(page.getByTestId("bumps")).toHaveText("2")
})

test("a pending Server Action call delays the next call but not a navigation", async ({
  page,
}) => {
  await openProbe(page)
  const sent: string[] = []
  page.on("request", (request) => {
    if (request.method() === "POST" && request.headers()["next-action"]) {
      sent.push(request.url())
    }
  })

  await setFaults(page, { delivery: "hang" })
  await page.getByRole("button", { name: "send bare" }).click()
  await expect.poll(() => sent.length).toBe(1)
  await page.getByRole("button", { name: "send bare" }).click()
  // Bounded wait, as above: an unqueued call leaves the page at once.
  await page.waitForTimeout(1_000)
  expect(sent).toHaveLength(1)

  await page.getByRole("link", { name: "go home" }).click()
  await expect(page).toHaveURL("/")
  // The navigation discarded the hung call's router update; the queued call
  // runs after it.
  await expect.poll(() => sent.length).toBe(2)
  await setFaults(page, {})
})
