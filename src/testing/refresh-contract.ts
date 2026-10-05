import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  UNCOVERED_REFRESH_RETRY_MS,
  useIncorporation,
  type RefreshAdapter,
} from "../refresh"
import { acceptedStamp, axisId, revisionVector, type Canon } from "../revisions"
import type { ContractCase } from "./contract-case"

/** Refresh carrier fixture used by reusable stall-state assertions. */
export interface RefreshContractHarness {
  readonly name: string
  readonly completion: "canon" | "request"
  readonly useRefresh: (request: () => void | Promise<void>) => RefreshAdapter
}

const contractAxis = axisId("headcanon/refresh-contract")

// Each call returns a new state object, as every delivered RSC payload or
// refetch does, so a void carrier's delivery is distinguishable from a
// re-render.
function contractCanon(revision: number): Canon<{ readonly revision: number }> {
  const parsed = revisionVector({ [contractAxis]: revision })
  if (!parsed.ok) throw new Error("Invalid refresh contract canon")
  return { value: { revision }, revisions: parsed.value }
}

function contractStamp(revision: number) {
  const parsed = acceptedStamp({ revisions: { [contractAxis]: revision } })
  if (!parsed.ok) throw new Error("Invalid refresh contract stamp")
  return parsed.value
}

async function flushMicrotasks() {
  await act(async () => Promise.resolve())
}

async function advance(ms: number) {
  await act(async () => vi.advanceTimersByTimeAsync(ms))
}

function setupRefreshContract(harness: RefreshContractHarness) {
  const request = vi.fn()
  const useRefresh = harness.useRefresh
  let acceptanceGraceMs = 0
  const rendered = renderHook(
    ({
      currentCanon,
    }: {
      readonly currentCanon: ReturnType<typeof contractCanon>
    }) => {
      const refresh = useRefresh(request)
      acceptanceGraceMs = refresh.acceptanceGraceMs
      return useIncorporation(currentCanon, refresh)
    },
    { initialProps: { currentCanon: contractCanon(0) } }
  )

  act(() =>
    rendered.result.current.recordAcceptance(
      "refresh-contract-mutation",
      contractStamp(1)
    )
  )

  return { ...rendered, acceptanceGraceMs, request }
}

async function completeAttempt(
  harness: RefreshContractHarness,
  rendered: ReturnType<typeof setupRefreshContract>
) {
  if (harness.completion === "canon") {
    rendered.rerender({ currentCanon: contractCanon(0) })
  }
  await flushMicrotasks()
}

/**
 * The refresh contract's cases for one harness. Module-internal: tests use it
 * to run the cases against deliberately broken harnesses. The cases need fake
 * timers and a DOM.
 * @param harness Refresh carrier fixture to exercise.
 * @returns The contract cases, in order.
 */
export function refreshContractCases(
  harness: RefreshContractHarness
): readonly ContractCase[] {
  return [
    {
      name: "honors carrier grace and stalls after two uncovered refreshes",
      async run() {
        const rendered = setupRefreshContract(harness)
        const { acceptanceGraceMs, result, request } = rendered

        await flushMicrotasks()
        if (acceptanceGraceMs > 0) {
          expect(result.current.status.freshness).toBe("grace")
          expect(request).not.toHaveBeenCalled()
          await advance(acceptanceGraceMs)
        }

        expect(request).toHaveBeenCalledTimes(1)
        await completeAttempt(harness, rendered)
        await advance(UNCOVERED_REFRESH_RETRY_MS)

        expect(request).toHaveBeenCalledTimes(2)
        await completeAttempt(harness, rendered)
        expect(result.current.status).toMatchObject({
          freshness: "stalled",
          stallReason: "behind",
        })
        rendered.unmount()
      },
    },
    {
      name: "gives manual retry a fresh two-attempt budget",
      async run() {
        const rendered = setupRefreshContract(harness)
        const { acceptanceGraceMs, result, request } = rendered

        await flushMicrotasks()
        if (acceptanceGraceMs > 0) await advance(acceptanceGraceMs)
        await completeAttempt(harness, rendered)
        await advance(UNCOVERED_REFRESH_RETRY_MS)
        await completeAttempt(harness, rendered)
        expect(result.current.status.freshness).toBe("stalled")

        act(() => result.current.retryRefresh())
        await flushMicrotasks()
        expect(request).toHaveBeenCalledTimes(3)
        await completeAttempt(harness, rendered)

        await advance(UNCOVERED_REFRESH_RETRY_MS)
        expect(request).toHaveBeenCalledTimes(4)
        await completeAttempt(harness, rendered)
        expect(result.current.status.freshness).toBe("stalled")
        rendered.unmount()
      },
    },
  ]
}

/**
 * Runs the reusable refresh incorporation contract against a refresh carrier.
 * Registers one vitest `describe` block, so call it at a test file's top
 * level. Needs `@testing-library/react` and a DOM: run the file in the
 * `jsdom` environment (`// @vitest-environment jsdom`). The block installs
 * vitest fake timers for its own tests.
 * @param harness Refresh carrier fixture to exercise.
 * @returns Nothing; registers the contract's tests.
 */
export function verifyRefreshContract(harness: RefreshContractHarness): void {
  describe(`${harness.name} refresh contract`, () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    for (const contractCase of refreshContractCases(harness)) {
      it(contractCase.name, () => contractCase.run())
    }
  })
}
