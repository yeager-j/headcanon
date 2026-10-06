import { expect, type Locator, type Page } from "@playwright/test"

import type { FixtureFaults, FixtureInspection } from "../../lib/authority"

/** Resets the authority and opens the fixture, marking the document. */
export async function openFixture(page: Page): Promise<void> {
  await page.request.post("/api/reset")
  await page.goto("/")
  // A full reload would also make canon-count advance; this marker proves the
  // canon arrived in place. It survives soft navigations but not reloads.
  await page.evaluate(() => {
    ;(window as { __stayedMounted?: boolean }).__stayedMounted = true
  })
}

/** Asserts that the document {@link openFixture} marked was never reloaded. */
export async function expectStayedMounted(page: Page): Promise<void> {
  expect(
    await page.evaluate(
      () => (window as { __stayedMounted?: boolean }).__stayedMounted
    )
  ).toBe(true)
}

/** Types `text` into the New item field and clicks Add, as a user would. */
export async function addItem(page: Page, text: string): Promise<void> {
  await page.getByLabel("New item").fill(text)
  await page.getByRole("button", { name: "Add" }).click()
}

/** Replaces the server's faults; omitted faults are off. */
export async function setFaults(
  page: Page,
  faults: Partial<FixtureFaults>
): Promise<void> {
  const response = await page.request.post("/api/faults", { data: faults })
  expect(response.ok()).toBe(true)
}

/** Commits an item as another client would, without telling this page. */
export async function writeAsAnotherClient(
  page: Page,
  text: string
): Promise<void> {
  const response = await page.request.post("/api/authority", {
    data: { text },
  })
  expect(response.ok()).toBe(true)
}

/** The authority's committed state and receipt count. */
export async function readAuthority(page: Page): Promise<FixtureInspection> {
  return (await page.request.get("/api/authority")).json()
}

/** The predicted items the page renders, in order. */
export function renderedItems(page: Page): Locator {
  return page.getByTestId("items").locator("li")
}

/** Waits until the root has nothing pending and canon is current. */
export async function expectSettled(page: Page): Promise<void> {
  await expect(page.getByTestId("pending")).toHaveText("0")
  await expect(page.getByTestId("delivery")).toHaveText("idle")
  await expect(page.getByTestId("freshness")).toHaveText("current")
}
