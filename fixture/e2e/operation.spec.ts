import { expect, test, type Page } from "@playwright/test"
import { DELIVERY_WAIT_MS } from "headcanon/react"

import { readAuthority, setFaults } from "./support/fixture-page"

/**
 * An operation through the real App Router: one key per submission, kept
 * through a lost response, a page load, and a hung call, so the receipt
 * returns the first answer instead of writing twice.
 */

/** Resets the authority and opens the operation form in `redirect` mode. */
async function openOperation(
  page: Page,
  redirect: "client" | "server" = "client"
): Promise<void> {
  await page.request.post("/api/reset")
  await page.goto(
    redirect === "server" ? "/operation?redirect=server" : "/operation"
  )
  await page.evaluate(() => globalThis.sessionStorage.clear())
  await page.reload()
}

async function createItem(page: Page, text: string): Promise<void> {
  await page.getByLabel("Item text").fill(text)
  await page.getByRole("button", { name: "Create" }).click()
}

const status = (page: Page) => page.getByTestId("operation-status")
const lastCall = (page: Page) => page.getByTestId("operation-last-call")

test("a retry after a lost response returns the first result", async ({
  page,
}) => {
  await openOperation(page)
  await setFaults(page, { delivery: "lose-response" })

  await createItem(page, "alpha")

  await expect(status(page)).toHaveText("unconfirmed")
  await expect(lastCall(page)).toHaveText("unconfirmed")
  expect(await readAuthority(page)).toEqual({
    items: ["alpha"],
    revision: 1,
    receipts: 1,
  })

  await setFaults(page, {})
  await page.getByRole("button", { name: "Retry" }).click()

  await expect(page).toHaveURL("/items/0")
  await expect(page.getByTestId("item-text")).toHaveText("alpha")
  expect(await readAuthority(page)).toEqual({
    items: ["alpha"],
    revision: 1,
    receipts: 1,
  })
})

test("a submission held across a page load is retried with its key", async ({
  page,
}) => {
  await openOperation(page)
  await setFaults(page, { delivery: "lose-response" })
  await createItem(page, "beta")
  await expect(status(page)).toHaveText("unconfirmed")

  await page.reload()

  await expect(status(page)).toHaveText("unconfirmed")
  await expect(page.getByTestId("operation-pending")).toHaveText(
    "beta (restored)"
  )
  await setFaults(page, {})
  await page.getByRole("button", { name: "Retry" }).click()

  await expect(page).toHaveURL("/items/0")
  expect(await readAuthority(page)).toEqual({
    items: ["beta"],
    revision: 1,
    receipts: 1,
  })
})

test("new input waits for retry or discard while a submission is held", async ({
  page,
}) => {
  await openOperation(page)
  await setFaults(page, { delivery: "fail" })
  await createItem(page, "gamma")
  await expect(status(page)).toHaveText("unconfirmed")

  await createItem(page, "delta")
  await expect(lastCall(page)).toHaveText("pending-submission")
  await expect(status(page)).toHaveText("unconfirmed")

  await page.getByRole("button", { name: "Discard" }).click()
  await expect(status(page)).toHaveText("idle")
  await setFaults(page, {})
  await createItem(page, "delta")

  await expect(page).toHaveURL("/items/0")
  expect(await readAuthority(page)).toEqual({
    items: ["delta"],
    revision: 1,
    receipts: 1,
  })
})

test("a form Action ends after the wait and a late answer still settles", async ({
  page,
}, testInfo) => {
  testInfo.setTimeout(testInfo.timeout + DELIVERY_WAIT_MS + 5_000)
  await openOperation(page)
  await setFaults(page, { delivery: "hang" })

  await createItem(page, "epsilon")
  await expect(status(page)).toHaveText("sending")

  await expect(lastCall(page)).toHaveText("unconfirmed", {
    timeout: DELIVERY_WAIT_MS + 5_000,
  })
  await expect(status(page)).toHaveText("unconfirmed")
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible()

  // Releasing the hung call lets it answer; the hook settles and navigates.
  await setFaults(page, {})

  await expect(page).toHaveURL("/items/0")
  expect(await readAuthority(page)).toEqual({
    items: ["epsilon"],
    revision: 1,
    receipts: 1,
  })
})

test("a refusal replays as the same refusal", async ({ page }) => {
  await openOperation(page)
  await createItem(page, "zeta")
  await expect(page).toHaveURL("/items/0")

  await page.goto("/operation")
  await setFaults(page, { delivery: "lose-response" })
  await createItem(page, "zeta")
  await expect(status(page)).toHaveText("unconfirmed")

  await setFaults(page, {})
  await page.getByRole("button", { name: "Retry" }).click()

  await expect(page.getByTestId("operation-outcome")).toHaveText(
    "refused: item-refused"
  )
  expect(await readAuthority(page)).toEqual({
    items: ["zeta"],
    revision: 1,
    receipts: 2,
  })
})

test("a server redirect lands on the first result after a lost response", async ({
  page,
}) => {
  await openOperation(page, "server")
  await setFaults(page, { delivery: "lose-response" })
  await createItem(page, "eta")
  await expect(status(page)).toHaveText("unconfirmed")

  await setFaults(page, {})
  await page.getByRole("button", { name: "Retry" }).click()

  await expect(page).toHaveURL("/items/0")
  await expect(page.getByTestId("item-text")).toHaveText("eta")

  // The redirect ended the submission, so the form holds nothing.
  await page.goto("/operation?redirect=server")
  await expect(status(page)).toHaveText("idle")
  expect(await readAuthority(page)).toEqual({
    items: ["eta"],
    revision: 1,
    receipts: 1,
  })
})
