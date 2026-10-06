import { expect, test } from "@playwright/test"
import { DELIVERY_WAIT_MS } from "headcanon/react"

import {
  addItem,
  expectSettled,
  expectStayedMounted,
  openFixture,
  readAuthority,
  renderedItems,
  setFaults,
  writeAsAnotherClient,
} from "./support/fixture-page"

/**
 * The root's recovery surfaces through the real App Router: refusals, a
 * denial, uncertain delivery and its retry, a replay conflict, a freshness
 * stall, and the bound on a held delivery Action. The server's test-only
 * faults (`/api/faults`) and a second writer (`/api/authority`) make each
 * condition happen on purpose.
 */

test("a duplicate is refused by the local prediction and never sent", async ({
  page,
}) => {
  await openFixture(page)
  await addItem(page, "alpha")
  await expect(page.getByTestId("canon-count")).toHaveText("1")
  await expectSettled(page)

  await addItem(page, "alpha")

  await expect(page.getByTestId("refusal")).toHaveText("item-refused")
  await expect(page.getByTestId("pending")).toHaveText("0")
  await expect(renderedItems(page)).toHaveText(["alpha"])
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
  await expect(page.getByTestId("refusal")).toHaveText("none")

  await expect(page.getByTestId("outcome")).toHaveText("refused: item-refused")
  await expectSettled(page)
  // A refusal changes nothing, so no canon rides back: the page shows the
  // canon it has, without the rolled-back prediction.
  await expect(renderedItems(page)).toHaveCount(0)
  await expect(page.getByTestId("canon-count")).toHaveText("0")

  await page.getByRole("button", { name: "Reload canon" }).click()
  await expect(renderedItems(page)).toHaveText(["beta"])
  await expect(page.getByTestId("canon-count")).toHaveText("1")
  await expectStayedMounted(page)
})

test("a denied mutation rolls back without a receipt", async ({ page }) => {
  await openFixture(page)
  await setFaults(page, { role: "reader" })

  await addItem(page, "gamma")

  await expect(page.getByTestId("outcome")).toHaveText("denied")
  await expectSettled(page)
  await expect(renderedItems(page)).toHaveCount(0)
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
  await expect(page.getByTestId("delivery")).toHaveText("uncertain")
  await expect(
    page.getByRole("button", { name: "Retry delivery" })
  ).toBeVisible()
  await expect(renderedItems(page)).toHaveText(["delta"])
  await expect(page.getByTestId("canon-count")).toHaveText("0")
  expect(await readAuthority(page)).toEqual({
    items: ["delta"],
    revision: 1,
    receipts: 1,
  })

  await setFaults(page, {})
  await page.getByRole("button", { name: "Retry delivery" }).click()

  // The retry sent the same mutation ID: the authority replayed the receipt
  // instead of appending a second "delta".
  await expect(page.getByTestId("outcome")).toHaveText("accepted")
  await expect(page.getByTestId("canon-count")).toHaveText("1")
  await expectSettled(page)
  await expect(
    page.getByRole("button", { name: "Retry delivery" })
  ).toBeHidden()
  await expect(renderedItems(page)).toHaveText(["delta"])
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
  await expect(page.getByTestId("delivery")).toHaveText("uncertain")

  // Another client commits the same item; newer canon makes the pending
  // prediction refuse on replay.
  await writeAsAnotherClient(page, "epsilon")
  await page.getByRole("button", { name: "Reload canon" }).click()

  await expect(page.getByTestId("canon-count")).toHaveText("1")
  await expect(page.getByTestId("conflicts")).toHaveText("1")
  await expect(page.getByTestId("conflict-log")).toHaveText(
    "epsilon: item-refused"
  )
  // The conflicted prediction no longer renders, so the item shows once.
  await expect(renderedItems(page)).toHaveText(["epsilon"])
  // The envelope may have committed, so it keeps waiting for its answer.
  await expect(page.getByTestId("pending")).toHaveText("1")
  await expect(page.getByTestId("delivery")).toHaveText("uncertain")

  await setFaults(page, {})
  await page.getByRole("button", { name: "Retry delivery" }).click()

  await expect(page.getByTestId("outcome")).toHaveText("refused: item-refused")
  await expectSettled(page)
  await expect(page.getByTestId("conflicts")).toHaveText("1")
  await expect(renderedItems(page)).toHaveText(["epsilon"])
})

test("a refresh that cannot catch up stalls as behind until retryRefresh", async ({
  page,
}) => {
  await openFixture(page)
  // Pages keep rendering the empty canon, whatever the authority commits.
  await setFaults(page, { freezeReads: true })

  await addItem(page, "zeta")
  await expect(page.getByTestId("outcome")).toHaveText("accepted")

  // Two refreshes come back without the accepted revision.
  await expect(page.getByTestId("freshness")).toHaveText("stalled", {
    timeout: 10_000,
  })
  await expect(page.getByTestId("stall-reason")).toHaveText("behind")
  await expect(
    page.getByRole("button", { name: "Retry refresh" })
  ).toBeVisible()
  // The accepted prediction stays rendered while canon lags.
  await expect(renderedItems(page)).toHaveText(["zeta"])
  await expect(page.getByTestId("canon-count")).toHaveText("0")
  await expect(page.getByTestId("pending")).toHaveText("1")
  await expect(page.getByTestId("delivery")).toHaveText("idle")

  await setFaults(page, {})
  await page.getByRole("button", { name: "Retry refresh" }).click()

  await expect(page.getByTestId("canon-count")).toHaveText("1")
  await expectSettled(page)
  await expect(page.getByTestId("stall-reason")).toHaveText("none")
  await expect(page.getByRole("button", { name: "Retry refresh" })).toBeHidden()
  await expect(renderedItems(page)).toHaveText(["zeta"])
  await expectStayedMounted(page)
})

test("a hung delivery becomes uncertain after the wait bound, and its late answer still settles", async ({
  page,
}, testInfo) => {
  const uncertainTimeout = DELIVERY_WAIT_MS + 5_000
  // The usual test budget, plus the wait for the delivery to become uncertain.
  testInfo.setTimeout(testInfo.timeout + uncertainTimeout)
  await openFixture(page)
  await setFaults(page, { delivery: "hang" })

  await addItem(page, "eta")
  await expect(page.getByTestId("delivery")).toHaveText("sending")
  await expect(renderedItems(page)).toHaveText(["eta"])

  // After the bound the root stops waiting, releases its Action, and offers
  // a retry; the prediction stays. (Next itself still holds every transition
  // until the Server Action responds; react-physics.spec.ts pins that.)
  await expect(page.getByTestId("delivery")).toHaveText("uncertain", {
    timeout: uncertainTimeout,
  })
  await expect(
    page.getByRole("button", { name: "Retry delivery" })
  ).toBeVisible()
  await expect(renderedItems(page)).toHaveText(["eta"])

  // Let the hung request finish. Its answer is still the authority's answer
  // for this mutation ID, so it settles the mutation without a retry.
  await setFaults(page, {})

  await expect(page.getByTestId("outcome")).toHaveText("accepted")
  await expect(page.getByTestId("canon-count")).toHaveText("1")
  await expectSettled(page)
  await expect(
    page.getByRole("button", { name: "Retry delivery" })
  ).toBeHidden()
  await expect(renderedItems(page)).toHaveText(["eta"])
  expect((await readAuthority(page)).receipts).toBe(1)
})
