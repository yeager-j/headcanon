import { expect, test, type Page } from "@playwright/test"

/**
 * The real-router negative control (UNN-682). The package's React contract
 * suite delivers canon by re-rendering a test harness, which is not what
 * `router.refresh()` or a Server Action's revalidated RSC payload do through
 * React's Action scheduling. These stories exercise the actual App Router
 * carrier end to end: a mutation must predict, deliver, and canonize IN PLACE
 * — no hard reload — while optimistic Actions are held open.
 */

async function openFixture(page: Page): Promise<void> {
  await page.request.post("/api/reset")
  await page.goto("/")
  // A full reload would also make canon-count advance; this marker proves the
  // canon arrived in place. It survives soft navigations but not reloads.
  await page.evaluate(() => {
    ;(window as { __stayedMounted?: boolean }).__stayedMounted = true
  })
}

async function expectStayedMounted(page: Page): Promise<void> {
  expect(
    await page.evaluate(
      () => (window as { __stayedMounted?: boolean }).__stayedMounted
    )
  ).toBe(true)
}

async function addItem(page: Page, text: string): Promise<void> {
  await page.getByLabel("New item").fill(text)
  await page.getByRole("button", { name: "Add" }).click()
}

test("a mutation predicts, then canonizes in place through the real router carrier", async ({
  page,
}) => {
  await openFixture(page)

  await addItem(page, "alpha")

  // Prediction is immediate.
  await expect(page.getByTestId("items").getByText("alpha")).toBeVisible()

  // The authoritative canon must arrive without any reload: the RSC payload
  // (or a coverage refresh) delivers it while the optimistic Action is open.
  await expect(page.getByTestId("canon-count")).toHaveText("1", {
    timeout: 15_000,
  })
  await expect(page.getByTestId("pending")).toHaveText("0")
  await expect(page.getByTestId("freshness")).toHaveText("current")
  await expect(page.getByTestId("delivery")).toHaveText("idle")

  await expectStayedMounted(page)
})

test("a burst of mutations preserves order and fully canonizes", async ({
  page,
}) => {
  await openFixture(page)

  await addItem(page, "first")
  await addItem(page, "second")
  await addItem(page, "third")

  // All three predictions render immediately, in dispatch order.
  await expect(page.getByTestId("items").locator("li")).toHaveText([
    "first",
    "second",
    "third",
  ])

  await expect(page.getByTestId("canon-count")).toHaveText("3", {
    timeout: 20_000,
  })
  await expect(page.getByTestId("pending")).toHaveText("0")
  await expect(page.getByTestId("freshness")).toHaveText("current")

  // Authority order matches dispatch order.
  await expect(page.getByTestId("items").locator("li")).toHaveText([
    "first",
    "second",
    "third",
  ])

  await expectStayedMounted(page)
})
