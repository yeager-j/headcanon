import { act, renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { useIncorporation, type RefreshAdapter } from "./refresh"
import { acceptedStamp, axisId, revisionVector, type Canon } from "./revisions"

export interface RefreshContractHarness {
  readonly name: string
  readonly completion: "canon" | "request"
  readonly useRefresh: (request: () => void | Promise<void>) => RefreshAdapter
}

const contractAxis = axisId("headcanon/refresh-contract")

function contractCanon(revision: number): Canon<number> {
  const parsed = revisionVector({ [contractAxis]: revision })
  if (!parsed.ok) throw new Error("Invalid refresh contract canon")
  return { value: revision, revisions: parsed.value }
}

function contractStamp(revision: number) {
  const parsed = revisionVector({ [contractAxis]: revision })
  if (!parsed.ok) throw new Error("Invalid refresh contract stamp")
  return acceptedStamp(parsed.value)
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
    ({ currentCanon }: { readonly currentCanon: Canon<number> }) => {
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

export function verifyRefreshContract(harness: RefreshContractHarness): void {
  describe(`${harness.name} refresh contract`, () => {
    it("honors carrier grace and stalls after two uncovered refreshes", async () => {
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
      await advance(1_000)

      expect(request).toHaveBeenCalledTimes(2)
      await completeAttempt(harness, rendered)
      expect(result.current.status).toMatchObject({
        freshness: "stalled",
        stallReason: "behind",
      })
    })

    it("gives manual retry a fresh two-attempt budget", async () => {
      const rendered = setupRefreshContract(harness)
      const { acceptanceGraceMs, result, request } = rendered

      await flushMicrotasks()
      if (acceptanceGraceMs > 0) await advance(acceptanceGraceMs)
      await completeAttempt(harness, rendered)
      await advance(1_000)
      await completeAttempt(harness, rendered)
      expect(result.current.status.freshness).toBe("stalled")

      act(() => result.current.retryRefresh())
      await flushMicrotasks()
      expect(request).toHaveBeenCalledTimes(3)
      await completeAttempt(harness, rendered)

      await advance(1_000)
      expect(request).toHaveBeenCalledTimes(4)
      await completeAttempt(harness, rendered)
      expect(result.current.status.freshness).toBe("stalled")
    })
  })
}
