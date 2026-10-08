import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  withVisibilityRefresh,
  type InvalidationAdapter,
} from "../../core/invalidation"
import {
  acceptedStamp,
  axisId,
  revisionVector,
  type AcceptedStamp,
  type Canon,
} from "../../core/revisions"
import {
  UNCOVERED_REFRESH_RETRY_MS,
  useIncorporation,
  type AcceptanceSource,
  type RefreshAdapter,
} from "../../react/refresh"
import { createInMemoryInvalidationAdapter } from "../in-memory-invalidation"
import type { ContractCase } from "./contract-case"

/** The refresh carrier that `verifyRefreshContract` exercises. */
export interface RefreshContractHarness {
  /** Label that prefixes the contract's `describe` block. */
  readonly name: string
  /**
   * What completes one refresh attempt for this carrier. Use `"request"` when
   * the adapter's `request()` returns a promise that settles once the refresh
   * is delivered. Use `"canon"` for a void carrier such as `router.refresh()`,
   * whose attempt completes only when the root receives a new canon (the
   * contract delivers one after each request).
   */
  readonly completion: "canon" | "request"
  /**
   * Hook the contract calls on every render of its root. Wrap `request`,
   * which the contract counts, in the carrier under test and return its
   * adapter.
   */
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

/** Stands in for a predicted root's ledger: the one store of acceptances. */
function contractAcceptances() {
  let accepted: ReadonlyMap<string, AcceptedStamp> = new Map()
  const listeners = new Set<() => void>()
  const source: AcceptanceSource = {
    getAccepted: () => accepted,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  return {
    source,
    accept(mutationId: string, stamp: AcceptedStamp) {
      accepted = new Map(accepted).set(mutationId, stamp)
      for (const listener of listeners) listener()
    },
  }
}

async function flushMicrotasks() {
  await act(async () => Promise.resolve())
}

async function advance(ms: number) {
  await act(async () => vi.advanceTimersByTimeAsync(ms))
}

function setupRefreshContract(
  harness: RefreshContractHarness,
  invalidations: InvalidationAdapter | undefined
) {
  const request = vi.fn()
  const useRefresh = harness.useRefresh
  const acceptances = contractAcceptances()
  let acceptanceGraceMs = 0
  const rendered = renderHook(
    ({
      currentCanon,
    }: {
      readonly currentCanon: ReturnType<typeof contractCanon>
    }) => {
      const refresh = useRefresh(request)
      acceptanceGraceMs = refresh.acceptanceGraceMs
      return useIncorporation(
        currentCanon,
        refresh,
        invalidations,
        acceptances.source
      )
    },
    { initialProps: { currentCanon: contractCanon(0) } }
  )

  const acceptMutation = () =>
    act(() => acceptances.accept("refresh-contract-mutation", contractStamp(1)))

  return { ...rendered, acceptanceGraceMs, acceptMutation, request }
}

/**
 * Runs one case on a fresh root and unmounts it however the case ends. The
 * root has no invalidation adapter unless the case passes one.
 */
async function withRefreshContract(
  harness: RefreshContractHarness,
  run: (rendered: ReturnType<typeof setupRefreshContract>) => Promise<void>,
  invalidations?: InvalidationAdapter
) {
  const rendered = setupRefreshContract(harness, invalidations)
  try {
    await run(rendered)
  } finally {
    rendered.unmount()
  }
}

/**
 * Gives a case control of `document.visibilityState` and restores the real
 * property however the case ends.
 */
async function withDocumentVisibility(
  run: (setVisibility: (next: DocumentVisibilityState) => void) => Promise<void>
) {
  let visibility: DocumentVisibilityState = "visible"
  const original = Object.getOwnPropertyDescriptor(document, "visibilityState")
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  })

  const setVisibility = (next: DocumentVisibilityState) => {
    visibility = next
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
  }

  try {
    await run(setVisibility)
  } finally {
    if (original) {
      Object.defineProperty(document, "visibilityState", original)
    } else {
      Reflect.deleteProperty(document, "visibilityState")
    }
  }
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
 * The refresh contract's cases for one harness. Internal to the package: tests
 * use it to run the cases against deliberately broken harnesses. The cases
 * need fake timers and a DOM.
 * @param harness The refresh carrier under test.
 * @param refreshOnVisible Wraps the active transport of the return-to-page
 *   case. Tests pass a broken wrapper to prove the case catches it.
 * @returns The contract cases, in order.
 */
export function refreshContractCases(
  harness: RefreshContractHarness,
  refreshOnVisible: (
    adapter: InvalidationAdapter
  ) => InvalidationAdapter = withVisibilityRefresh
): readonly ContractCase[] {
  return [
    {
      name: "honors carrier grace and stalls after two uncovered refreshes",
      run: () =>
        withRefreshContract(harness, async (rendered) => {
          const { acceptanceGraceMs, result, request } = rendered

          rendered.acceptMutation()
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
        }),
    },
    {
      name: "gives manual retry a fresh two-attempt budget",
      run: () =>
        withRefreshContract(harness, async (rendered) => {
          const { acceptanceGraceMs, result, request } = rendered

          rendered.acceptMutation()
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
        }),
    },
    {
      name: "refreshes a current root once when the document becomes visible",
      run: () =>
        withDocumentVisibility((setVisibility) =>
          withRefreshContract(
            harness,
            async (rendered) => {
              const { result, request } = rendered

              await flushMicrotasks()
              expect(result.current.status).toMatchObject({
                freshness: "current",
                invalidations: "active",
              })

              setVisibility("hidden")
              await flushMicrotasks()
              expect(request).not.toHaveBeenCalled()

              setVisibility("visible")
              await flushMicrotasks()
              expect(request).toHaveBeenCalledTimes(1)
              await completeAttempt(harness, rendered)
              expect(result.current.status.freshness).toBe("current")

              await advance(UNCOVERED_REFRESH_RETRY_MS)
              expect(request).toHaveBeenCalledTimes(1)
            },
            refreshOnVisible(createInMemoryInvalidationAdapter())
          )
        ),
    },
  ]
}

/**
 * Runs the reusable refresh incorporation contract against a refresh carrier.
 * Registers one vitest `describe` block, so call it at a test file's top
 * level. Needs `@testing-library/react` and a DOM: run the file in the
 * `jsdom` environment (`// @vitest-environment jsdom`). The block installs
 * vitest fake timers for its own tests and unmounts every root it renders.
 * One case wraps an active transport in `withVisibilityRefresh` and replaces
 * `document.visibilityState` until it ends.
 * @param harness The refresh carrier under test.
 * @returns Nothing; registers the contract's tests.
 * @example
 * verifyRefreshContract({
 *   name: "router",
 *   completion: "canon",
 *   useRefresh: (request) => ({
 *     acceptanceGraceMs: ROUTER_ACCEPTANCE_GRACE_MS,
 *     request,
 *   }),
 * })
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
