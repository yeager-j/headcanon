import { expect, test, type Page } from "@playwright/test"

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
 *    not the app: a Server Action that never answers still freezes it.
 */

async function openProbe(page: Page): Promise<void> {
  await page.request.post("/api/reset")
  await page.goto("/probe")
}

const button = (page: Page, name: string) => page.getByRole("button", { name })

test("a Server Action payload parks behind an open Action and flushes atomically", async ({
  page,
}) => {
  await openProbe(page)

  await button(page, "mutate inside").click()
  // Deterministic observation point: the action's response has been processed
  // (acceptance logged) while its owning Action is still held open.
  await expect(page.getByTestId("log")).toContainText("accepted rev=1")
  await expect(page.getByTestId("frame")).toHaveText("inside-1")
  // Snapshot, not poll: the payload must NOT have committed.
  expect(await page.getByTestId("revision").textContent()).toBe("0")

  // Record every intermediate frame across the flush; the prediction must
  // never disappear while the old canon is still rendered.
  await page.evaluate(() => {
    const frames: Array<{ frame: string; revision: string }> = []
    const read = (testId: string) =>
      document.querySelector(`[data-testid="${testId}"]`)?.textContent ?? ""
    const observer = new MutationObserver(() => {
      frames.push({ frame: read("frame"), revision: read("revision") })
    })
    observer.observe(document.querySelector("main")!, {
      subtree: true,
      childList: true,
      characterData: true,
    })
    ;(window as unknown as { __frames: typeof frames }).__frames = frames
  })

  await button(page, "release all").click()
  await expect(page.getByTestId("revision")).toHaveText("1")
  await expect(page.getByTestId("frame")).toHaveText("inside-1")

  const frames = (await page.evaluate(
    () => (window as unknown as { __frames: unknown }).__frames
  )) as Array<{ frame: string; revision: string }>
  // Non-vacuity: the flush must have produced observable commits (at minimum
  // the revision text change), or the atomicity loop below proves nothing.
  expect(frames.length).toBeGreaterThan(0)
  for (const frame of frames) {
    expect(frame.frame).toContain("inside-1")
  }
})

test("navigation is blocked while an Action is held open and proceeds on settlement", async ({
  page,
}) => {
  await openProbe(page)

  await button(page, "mutate inside").click()
  await expect(page.getByTestId("log")).toContainText("accepted rev=1")

  await page.getByRole("link", { name: "go home" }).click()
  // Proving a navigation does *not* happen needs a bounded wait: no event
  // signals "still blocked". A local client-side navigation commits in tens
  // of milliseconds, so one second is well past the point it would have.
  await page.waitForTimeout(1_000)
  expect(new URL(page.url()).pathname).toBe("/probe")

  await button(page, "release all").click()
  await expect(page).toHaveURL("/")
})

test("a pending Server Action call holds every transition until it responds, with no Action open", async ({
  page,
}) => {
  await openProbe(page)
  // Control: with nothing pending, a transition commits at once.
  await button(page, "bump in a transition").click()
  await expect(page.getByTestId("bumps")).toHaveText("1")

  await page.request.post("/api/faults", { data: { delivery: "hang" } })
  await button(page, "send bare").click()
  await button(page, "bump in a transition").click()
  // Bounded wait, as above: a transition commits in milliseconds.
  await page.waitForTimeout(1_000)
  expect(await page.getByTestId("bumps").textContent()).toBe("1")

  await page.request.post("/api/faults", { data: {} })
  await expect(page.getByTestId("log")).toContainText("bare:bare-1 accepted")
  await expect(page.getByTestId("bumps")).toHaveText("2")
})
