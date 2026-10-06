import { expect, test } from "@playwright/test"

import {
  addItem,
  expectSettled,
  expectStayedMounted,
  openFixture,
  readAuthority,
  setFaults,
  testId,
  writeAsAnotherClient,
} from "./support/fixture-page"

/**
 * The root's recovery surfaces through the real App Router: refusals, a
 * denial, uncertain delivery and its retry, a replay conflict, a freshness
 * stall, and the bound on a held delivery Action. The server's test-only
 * faults (`/api/faults`) and a second writer (`/api/authority`) make each
 * condition happen on purpose.
 */

const items = (page: Parameters<typeof testId>[0]) =>
  testId(page, "items").locator("li")

test("a duplicate is refused by the local prediction and never sent", async ({
  page,
}) => {
  await openFixture(page)
  await addItem(page, "alpha")
  await expect(testId(page, "canon-count")).toHaveText("1")
  await expectSettled(page)

  await addItem(page, "alpha")

  await expect(testId(page, "refusal")).toHaveText("item-refused")
  await expect(testId(page, "pending")).toHaveText("0")
  await expect(items(page)).toHaveText(["alpha"])
  // Only the first delivery reached the authority.
  expect((await readAuthority(page)).receipts).toBe(1)
})

test("the authority refuses a duplicate this page has not seen, and the prediction rolls back", async ({
  page,
}) => {
  await openFixture(page)
  await writeAsAnotherClient(page, "beta")

  // This page's canon is empty, so the prediction succeeds.
  await addItem(page, "beta")
  await expect(testId(page, "refusal")).toHaveText("none")

  await expect(testId(page, "outcome")).toHaveText("refused: item-refused")
  await expectSettled(page)
  // A refusal changes nothing, so no canon rides back: the page shows the
  // canon it has, without the rolled-back prediction.
  await expect(items(page)).toHaveCount(0)
  await expect(testId(page, "canon-count")).toHaveText("0")

  await page.getByRole("button", { name: "Reload canon" }).click()
  await expect(items(page)).toHaveText(["beta"])
  await expect(testId(page, "canon-count")).toHaveText("1")
  await expectStayedMounted(page)
})

test("a denied mutation rolls back without a receipt", async ({ page }) => {
  await openFixture(page)
  await setFaults(page, { role: "reader" })

  await addItem(page, "gamma")

  await expect(testId(page, "outcome")).toHaveText("denied")
  await expectSettled(page)
  await expect(items(page)).toHaveCount(0)
  expect(await readAuthority(page)).toEqual({
    items: [],
    revision: 0,
    receipts: 0,
  })
})

test("retryDelivery after a lost response recovers the stored receipt", async ({
  page,
}) => {
  await openFixture(page)
  await setFaults(page, { delivery: "lose-response" })

  await addItem(page, "delta")

  // The commit exists, but the page did not hear about it.
  await expect(testId(page, "delivery")).toHaveText("uncertain")
  await expect(
    page.getByRole("button", { name: "Retry delivery" })
  ).toBeVisible()
  await expect(items(page)).toHaveText(["delta"])
  await expect(testId(page, "canon-count")).toHaveText("0")
  expect(await readAuthority(page)).toEqual({
    items: ["delta"],
    revision: 1,
    receipts: 1,
  })

  await setFaults(page, {})
  await page.getByRole("button", { name: "Retry delivery" }).click()

  // The retry sent the same mutation ID: the authority replayed the receipt
  // instead of appending a second "delta".
  await expect(testId(page, "outcome")).toHaveText("accepted")
  await expect(testId(page, "canon-count")).toHaveText("1")
  await expectSettled(page)
  await expect(
    page.getByRole("button", { name: "Retry delivery" })
  ).toBeHidden()
  await expect(items(page)).toHaveText(["delta"])
  expect(await readAuthority(page)).toEqual({
    items: ["delta"],
    revision: 1,
    receipts: 1,
  })
  await expectStayedMounted(page)
})

test("a replay conflict surfaces while delivery is uncertain", async ({
  page,
}) => {
  await openFixture(page)
  await setFaults(page, { delivery: "fail" })

  await addItem(page, "epsilon")
  await expect(testId(page, "delivery")).toHaveText("uncertain")

  // Another client commits the same item; newer canon makes the pending
  // prediction refuse on replay.
  await writeAsAnotherClient(page, "epsilon")
  await page.getByRole("button", { name: "Reload canon" }).click()

  await expect(testId(page, "canon-count")).toHaveText("1")
  await expect(testId(page, "conflicts")).toHaveText("1")
  await expect(testId(page, "conflict-log")).toHaveText("epsilon: item-refused")
  // The conflicted prediction no longer renders, so the item shows once.
  await expect(items(page)).toHaveText(["epsilon"])
  // The envelope may have committed, so it keeps waiting for its answer.
  await expect(testId(page, "pending")).toHaveText("1")
  await expect(testId(page, "delivery")).toHaveText("uncertain")

  await setFaults(page, {})
  await page.getByRole("button", { name: "Retry delivery" }).click()

  await expect(testId(page, "outcome")).toHaveText("refused: item-refused")
  await expectSettled(page)
  await expect(testId(page, "conflicts")).toHaveText("1")
  await expect(items(page)).toHaveText(["epsilon"])
})

test("a refresh that cannot catch up stalls as behind until retryRefresh", async ({
  page,
}) => {
  await openFixture(page)
  // Pages keep rendering the empty canon, whatever the authority commits.
  await setFaults(page, { freezeReads: true })

  await addItem(page, "zeta")
  await expect(testId(page, "outcome")).toHaveText("accepted")

  // Two refreshes come back without the accepted revision.
  await expect(testId(page, "freshness")).toHaveText("stalled", {
    timeout: 10_000,
  })
  await expect(testId(page, "stall-reason")).toHaveText("behind")
  await expect(
    page.getByRole("button", { name: "Retry refresh" })
  ).toBeVisible()
  // The accepted prediction stays rendered while canon lags.
  await expect(items(page)).toHaveText(["zeta"])
  await expect(testId(page, "canon-count")).toHaveText("0")
  await expect(testId(page, "pending")).toHaveText("1")
  await expect(testId(page, "delivery")).toHaveText("idle")

  await setFaults(page, {})
  await page.getByRole("button", { name: "Retry refresh" }).click()

  await expect(testId(page, "canon-count")).toHaveText("1")
  await expectSettled(page)
  await expect(testId(page, "stall-reason")).toHaveText("none")
  await expect(page.getByRole("button", { name: "Retry refresh" })).toBeHidden()
  await expect(items(page)).toHaveText(["zeta"])
  await expectStayedMounted(page)
})

test("a hung delivery becomes uncertain after the wait bound, and its late answer still settles", async ({
  page,
}) => {
  // DELIVERY_WAIT_MS is 10 seconds.
  test.setTimeout(45_000)
  await openFixture(page)
  await setFaults(page, { delivery: "hang" })

  await addItem(page, "eta")
  await expect(testId(page, "delivery")).toHaveText("sending")
  await expect(items(page)).toHaveText(["eta"])

  // After the bound the root stops waiting, releases its Action, and offers
  // a retry; the prediction stays. (Next itself still holds every transition
  // until the Server Action responds; react-physics.spec.ts pins that.)
  await expect(testId(page, "delivery")).toHaveText("uncertain", {
    timeout: 15_000,
  })
  await expect(
    page.getByRole("button", { name: "Retry delivery" })
  ).toBeVisible()
  await expect(items(page)).toHaveText(["eta"])

  // Let the hung request finish. Its answer is still the authority's answer
  // for this mutation ID, so it settles the mutation without a retry.
  await setFaults(page, {})

  await expect(testId(page, "outcome")).toHaveText("accepted")
  await expect(testId(page, "canon-count")).toHaveText("1")
  await expectSettled(page)
  await expect(
    page.getByRole("button", { name: "Retry delivery" })
  ).toBeHidden()
  await expect(items(page)).toHaveText(["eta"])
  expect((await readAuthority(page)).receipts).toBe(1)
})
