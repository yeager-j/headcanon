// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ROUTER_ACCEPTANCE_GRACE_MS } from "../next/client"
import { refreshContractCases } from "./refresh-contract"

describe("refresh contract negative controls", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("fails a router-shaped carrier that claims its request delivers canon", async () => {
    // The router's refresh resolves before the new payload arrives; a harness
    // that waits on the request instead of canon never completes an attempt.
    const cases = refreshContractCases({
      name: "broken",
      completion: "request",
      useRefresh: (request) => ({
        acceptanceGraceMs: ROUTER_ACCEPTANCE_GRACE_MS,
        request,
      }),
    })
    const failing: string[] = []
    for (const contractCase of cases) {
      try {
        await contractCase.run()
      } catch {
        failing.push(contractCase.name)
      }
    }

    expect(failing).toContain(
      "honors carrier grace and stalls after two uncovered refreshes"
    )
  })
})
