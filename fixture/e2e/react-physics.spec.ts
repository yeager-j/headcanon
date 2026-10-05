import { expect, test, type Page } from "@playwright/test"

/**
 * Platform-physics regression tests (UNN-682). The package's design rests on
 * three React 19 / Next 16 facts, established here against the real runtime
 * via /probe (raw `useOptimistic` + `startTransition` + a Server Action — no
 * headcanon code). If a React or Next upgrade changes any of these, the
 * package's settlement model must be revisited before trusting green tests.
 *
 * 1. A Server Action's revalidated RSC payload is PARKED while any optimistic
 *    Action is held open — regardless of where the send was invoked.
 * 2. The parked payload commits atomically with Action settlement: there is
 *    no intermediate frame showing canon without the prediction.
 * 3. A held-open Action blocks router navigation entirely.
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
  await page.waitForTimeout(1_000)
  expect(new URL(page.url()).pathname).toBe("/probe")

  await button(page, "release all").click()
  await expect(page).toHaveURL("/")
})
