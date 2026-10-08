// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { withPollingFallback } from "../core/invalidation"
import { ROUTER_ACCEPTANCE_GRACE_MS } from "../next/client"
import type { ContractCase } from "./suites/contract-case"
import {
  refreshContractCases,
  type RefreshContractHarness,
} from "./suites/refresh-contract"

const RETURN_TO_PAGE_CASE =
  "refreshes a current root once when the document becomes visible"

const routerShaped: RefreshContractHarness = {
  name: "router-shaped",
  completion: "canon",
  useRefresh: (request) => ({
    acceptanceGraceMs: ROUTER_ACCEPTANCE_GRACE_MS,
    request,
  }),
}

async function failingCaseNames(
  cases: readonly ContractCase[]
): Promise<string[]> {
  const failing: string[] = []
  for (const contractCase of cases) {
    try {
      await contractCase.run()
    } catch {
      failing.push(contractCase.name)
    }
  }

  return failing
}

describe("refresh contract negative controls", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("fails a router-shaped carrier that claims its request delivers canon", async () => {
    // The router's refresh resolves before the new payload arrives; a harness
    // that waits on the request instead of canon never completes an attempt.
    const failing = await failingCaseNames(
      refreshContractCases({ ...routerShaped, completion: "request" })
    )

    expect(failing).toContain(
      "honors carrier grace and stalls after two uncovered refreshes"
    )
    expect(failing).toContain(RETURN_TO_PAGE_CASE)
  })

  it("fails a return-to-page refresh that runs only while push is degraded", async () => {
    // Polling fallback's visibility refresh: an active transport never polls,
    // so a current root would miss changes published while the page was away.
    const failing = await failingCaseNames(
      refreshContractCases(routerShaped, (adapter) =>
        withPollingFallback(adapter, { intervalMs: 60_000 })
      )
    )

    expect(failing).toEqual([RETURN_TO_PAGE_CASE])
  })
})
