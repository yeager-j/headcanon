import { expect, test } from "@playwright/test"

import {
  addItem,
  expectSettled,
  expectStayedMounted,
  openFixture,
  testId,
} from "./support/fixture-page"

/**
 * The real-router negative control (UNN-682). The package's React contract
 * suite delivers canon by re-rendering a test harness, which is not what
 * `router.refresh()` or a Server Action's revalidated RSC payload do through
 * React's Action scheduling. These stories run the package's golden path —
 * the `action` form of `createNextPredictedRoot` over a generated
 * `createNextMutationAction` — through the actual App Router: a mutation must
 * predict, deliver, and canonize IN PLACE, with no hard reload. Each delivery
 * attempt holds a React Action open until its answer arrives, so the
 * action's own RSC payload is parked behind that Action; a deadlock there
 * shows as `pending` never returning to 0.
 */

test("a mutation predicts, then canonizes in place through the real router carrier", async ({
  page,
}) => {
  await openFixture(page)

  await addItem(page, "alpha")

  // Prediction is immediate.
  await expect(testId(page, "items").getByText("alpha")).toBeVisible()

  // The authoritative canon must arrive without any reload: the Server
  // Action's RSC payload (or a coverage refresh) delivers it.
  await expect(testId(page, "canon-count")).toHaveText("1", {
    timeout: 15_000,
  })
  await expectSettled(page)
  await expect(testId(page, "outcome")).toHaveText("accepted")

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
  await expect(testId(page, "items").locator("li")).toHaveText([
    "first",
    "second",
    "third",
  ])

  await expect(testId(page, "canon-count")).toHaveText("3", {
    timeout: 20_000,
  })
  await expectSettled(page)

  // Authority order matches dispatch order.
  await expect(testId(page, "items").locator("li")).toHaveText([
    "first",
    "second",
    "third",
  ])

  await expectStayedMounted(page)
})
