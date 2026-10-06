// @vitest-environment jsdom

import type { StandardSchemaV1 } from "@standard-schema/spec"
import { act, renderHook } from "@testing-library/react"
import { useSyncExternalStore } from "react"
import { ok, type Result } from "serializable-result"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  acceptedStamp,
  axisId,
  createNoRealtimeInvalidationAdapter,
  defineMutation,
  defineProtocol,
  revisionVector,
  withPollingFallback,
  type AcceptedStamp,
  type AxisInvalidation,
  type Canon,
  type InvalidationAdapter,
  type InvalidationSubscription,
  type MutationEnvelope,
  type Revision,
} from "./index"
import { ROUTER_ACCEPTANCE_GRACE_MS } from "./next/client"
import {
  createObservedRoot,
  createPredictedRoot,
  useSnapshotRefresh,
  type PredictedRootRecoveryListeners,
  type RefreshAdapter,
} from "./react"
import {
  SNAPSHOT_ACCEPTANCE_GRACE_MS,
  UNCOVERED_REFRESH_RETRY_MS,
  useIncorporation,
  type AcceptanceSource,
  type IncorporationStatus,
} from "./refresh"
import { covers } from "./revisions"
import { createInMemoryInvalidationAdapter } from "./testing/index"
import { verifyRefreshContract } from "./testing/react"

type TestError = { readonly code: "refused" }
type AddArgs = { readonly amount: number }

const addArgsSchema: StandardSchemaV1<unknown, AddArgs> = {
  "~standard": {
    version: 1,
    vendor: "headcanon-refresh-test",
    validate(value) {
      return { value: value as AddArgs }
    },
  },
}

const add = defineMutation({
  name: "refresh.add",
  args: addArgsSchema,
  predict(state: number, args): Result<number, TestError> {
    return ok(state + args.amount)
  },
})

const protocol = defineProtocol({
  id: "test.refresh.v1",
  mutations: [add],
})

const valueAxis = axisId("refresh/value")
const missingAxis = axisId("refresh/missing")

function revisions(entries: Record<string, number>) {
  const parsed = revisionVector(entries)
  if (!parsed.ok) throw new Error("Invalid refresh test revisions")
  return parsed.value
}

function canon(value: number, revision: number): Canon<number> {
  return { value, revisions: revisions({ [valueAxis]: revision }) }
}

function stamp(entries: Record<string, number>): AcceptedStamp {
  const parsed = acceptedStamp({ revisions: entries })
  if (!parsed.ok) throw new Error("Invalid refresh test stamp")
  return parsed.value
}

/** Stands in for a predicted root's ledger: the one store of acceptances. */
function testAcceptances() {
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
  const publish = (next: Map<string, AcceptedStamp>) => {
    accepted = next
    for (const listener of listeners) listener()
  }
  return {
    source,
    accept(mutationId: string, stamp: AcceptedStamp) {
      publish(new Map(accepted).set(mutationId, stamp))
    },
    remove(mutationId: string) {
      const next = new Map(accepted)
      next.delete(mutationId)
      publish(next)
    },
  }
}

function flushMicrotasks() {
  return act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

function advance(ms: number) {
  return act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

function setupPredictedRefresh(options: {
  readonly acceptanceGraceMs: number
  readonly acceptedStamp?: AcceptedStamp
  readonly invalidations?: InvalidationAdapter
  readonly request?: () => void | Promise<void>
  readonly recoveryListeners?: PredictedRootRecoveryListeners<
    ReturnType<typeof add>,
    TestError
  >
}) {
  const request = vi.fn(options.request ?? (async () => undefined))
  const adapter: RefreshAdapter = {
    acceptanceGraceMs: options.acceptanceGraceMs,
    request,
  }
  function useRefresh() {
    return adapter
  }
  const send = vi.fn(
    async (_envelope: MutationEnvelope<ReturnType<typeof add>>) =>
      ok(options.acceptedStamp ?? stamp({ [valueAxis]: 1 }))
  )
  const useRoot = createPredictedRoot({
    protocol,
    send,
    refresh: useRefresh,
    invalidations: options.invalidations,
    recoveryListeners: options.recoveryListeners,
  })
  const rendered = renderHook(
    ({ currentCanon }: { readonly currentCanon: Canon<number> }) =>
      useRoot({ canon: currentCanon }),
    { initialProps: { currentCanon: canon(0, 0) } }
  )

  act(() => {
    const outcome = rendered.result.current.mutate(add({ amount: 1 }))
    if (!outcome.ok) throw new Error("Refresh test mutation was refused")
  })

  return { ...rendered, request, send }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("refresh adapters", () => {
  it("declares zero grace and awaits snapshot refetch", async () => {
    const refetch = vi.fn(async () => undefined)
    const { result } = renderHook(() => useSnapshotRefresh(refetch))

    expect(result.current.acceptanceGraceMs).toBe(0)
    await act(async () => result.current.request())
    expect(refetch).toHaveBeenCalledOnce()
  })
})

verifyRefreshContract({
  name: "router-shaped",
  completion: "canon",
  useRefresh(request) {
    return { acceptanceGraceMs: ROUTER_ACCEPTANCE_GRACE_MS, request }
  },
})
verifyRefreshContract({
  name: "snapshot-shaped",
  completion: "request",
  useRefresh(request) {
    return {
      acceptanceGraceMs: SNAPSHOT_ACCEPTANCE_GRACE_MS,
      request: async () => request(),
    }
  },
})

describe("refresh incorporation", () => {
  it("uses acceptance grace only for the router-shaped carrier", async () => {
    const router = setupPredictedRefresh({
      acceptanceGraceMs: ROUTER_ACCEPTANCE_GRACE_MS,
    })
    await flushMicrotasks()

    expect(router.result.current.status.freshness).toBe("grace")
    expect(router.request).not.toHaveBeenCalled()
    await advance(ROUTER_ACCEPTANCE_GRACE_MS - 1)
    expect(router.request).not.toHaveBeenCalled()
    await advance(1)
    expect(router.request).toHaveBeenCalledOnce()
    router.unmount()

    const snapshot = setupPredictedRefresh({
      acceptanceGraceMs: SNAPSHOT_ACCEPTANCE_GRACE_MS,
    })
    await flushMicrotasks()
    expect(snapshot.request).toHaveBeenCalledOnce()
    expect(snapshot.result.current.status.freshness).toBe("refreshing")
  })

  it("waits for a void carrier to deliver canon before consuming an attempt", async () => {
    const { request, result, rerender } = setupPredictedRefresh({
      acceptanceGraceMs: 0,
      acceptedStamp: stamp({ [valueAxis]: 3 }),
      request: () => undefined,
    })
    await flushMicrotasks()

    expect(request).toHaveBeenCalledOnce()
    await advance(5 * UNCOVERED_REFRESH_RETRY_MS)
    expect(request).toHaveBeenCalledOnce()
    expect(result.current.status.freshness).toBe("refreshing")

    // A lagging delivery: newer revisions that still do not cover the stamp.
    rerender({ currentCanon: canon(1, 1) })
    await flushMicrotasks()
    await advance(UNCOVERED_REFRESH_RETRY_MS - 1)
    expect(request).toHaveBeenCalledOnce()
    await advance(1)
    expect(request).toHaveBeenCalledTimes(2)
    expect(result.current.status.freshness).toBe("refreshing")

    rerender({ currentCanon: canon(2, 2) })
    await flushMicrotasks()
    expect(result.current.status).toMatchObject({
      freshness: "stalled",
      stallReason: "behind",
    })
  })

  it("does not consume a void attempt on a same-canon or rebuilt-canon re-render", async () => {
    const state = { items: ["a"] }
    const mounted: Canon<typeof state> = {
      value: state,
      revisions: revisions({ [valueAxis]: 0 }),
    }
    const request = vi.fn(() => undefined)
    const refresh: RefreshAdapter = { acceptanceGraceMs: 0, request }
    const acceptances = testAcceptances()
    const { result, rerender } = renderHook(
      ({ currentCanon }: { readonly currentCanon: Canon<typeof state> }) =>
        useIncorporation(currentCanon, refresh, undefined, acceptances.source),
      { initialProps: { currentCanon: mounted } }
    )
    act(() => acceptances.accept("m1", stamp({ [valueAxis]: 1 })))
    await flushMicrotasks()
    expect(request).toHaveBeenCalledOnce()

    // An unrelated parent re-render passes the same canon object.
    rerender({ currentCanon: mounted })
    await flushMicrotasks()
    // A parent that rebuilds the canon wrapper around the same state.
    rerender({
      currentCanon: { value: state, revisions: revisions({ [valueAxis]: 0 }) },
    })
    await flushMicrotasks()
    await advance(5 * UNCOVERED_REFRESH_RETRY_MS)
    expect(request).toHaveBeenCalledOnce()
    expect(result.current.status.freshness).toBe("refreshing")

    // The carrier delivers: a new state object, still behind the stamp.
    rerender({
      currentCanon: {
        value: { items: ["a"] },
        revisions: revisions({ [valueAxis]: 0 }),
      },
    })
    await flushMicrotasks()
    await advance(UNCOVERED_REFRESH_RETRY_MS)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it("owns stalled-freshness listener cleanup until the root recovers", async () => {
    const cleanup = vi.fn()
    const onFreshnessStalled = vi.fn(() => cleanup)
    const { result, rerender } = setupPredictedRefresh({
      acceptanceGraceMs: 0,
      recoveryListeners: { onFreshnessStalled },
    })

    await flushMicrotasks()
    await advance(UNCOVERED_REFRESH_RETRY_MS)
    await flushMicrotasks()

    expect(result.current.status.freshness).toBe("stalled")
    expect(onFreshnessStalled).toHaveBeenCalledWith({
      retry: result.current.retryRefresh,
      reason: "behind",
      missingAxes: [],
    })

    rerender({ currentCanon: canon(1, 1) })
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it("deduplicates an own-write invalidation against recorded acceptance", async () => {
    const invalidations = controlledInvalidations()
    const { request, result } = setupPredictedRefresh({
      acceptanceGraceMs: ROUTER_ACCEPTANCE_GRACE_MS,
      invalidations: invalidations.adapter,
    })
    await flushMicrotasks()

    act(() =>
      invalidations.subscriptions[0]?.onInvalidation({
        eventId: "own-write",
        axis: valueAxis,
        revision: 1 as Revision,
      })
    )
    await flushMicrotasks()

    expect(result.current.status.freshness).toBe("grace")
    expect(request).not.toHaveBeenCalled()
  })

  it("classifies a stamped axis absent from canon as missing-axis", async () => {
    const { result } = setupPredictedRefresh({
      acceptanceGraceMs: 0,
      acceptedStamp: stamp({ [valueAxis]: 1, [missingAxis]: 1 }),
    })

    await flushMicrotasks()
    await advance(UNCOVERED_REFRESH_RETRY_MS)

    expect(result.current.status).toMatchObject({
      freshness: "stalled",
      stallReason: "missing-axis",
      missingAxes: [missingAxis],
    })
  })

  it("completes the dedicated refresh cycle while an optimistic Action remains open", async () => {
    const { result, request } = setupPredictedRefresh({
      acceptanceGraceMs: 0,
    })

    await flushMicrotasks()
    expect(result.current.status.pending).toBe(1)
    expect(request).toHaveBeenCalledOnce()

    await advance(UNCOVERED_REFRESH_RETRY_MS)

    expect(request).toHaveBeenCalledTimes(2)
    expect(result.current.status.pending).toBe(1)
    expect(result.current.status.freshness).toBe("stalled")
  })

  it("classifies two adapter failures as refresh-error", async () => {
    const { result, request } = setupPredictedRefresh({
      acceptanceGraceMs: 0,
      request: async () => {
        throw new Error("refresh failed")
      },
    })

    await flushMicrotasks()
    await advance(UNCOVERED_REFRESH_RETRY_MS)

    expect(request).toHaveBeenCalledTimes(2)
    expect(result.current.status).toMatchObject({
      freshness: "stalled",
      stallReason: "refresh-error",
    })
  })

  it("returns to current when a later canon covers the requirement", async () => {
    const { result, rerender } = setupPredictedRefresh({
      acceptanceGraceMs: 0,
    })

    await flushMicrotasks()
    rerender({ currentCanon: canon(1, 1) })
    await flushMicrotasks()

    expect(result.current.status.freshness).toBe("current")
    expect(result.current.status.pending).toBe(0)
  })
})

describe("acceptance requirements", () => {
  it("requires exactly the source's uncovered stamps in every render", () => {
    const acceptances = testAcceptances()
    const refresh: RefreshAdapter = {
      acceptanceGraceMs: ROUTER_ACCEPTANCE_GRACE_MS,
      request: vi.fn(async () => undefined),
    }
    const mounted = canon(0, 0)
    const renders: {
      readonly accepted: ReadonlyMap<string, AcceptedStamp>
      readonly status: IncorporationStatus
    }[] = []
    renderHook(() => {
      // Reads the source in render, as a predicted root reads its ledger.
      const accepted = useSyncExternalStore(
        acceptances.source.subscribe,
        acceptances.source.getAccepted
      )
      const { status } = useIncorporation(
        mounted,
        refresh,
        undefined,
        acceptances.source
      )
      renders.push({ accepted, status })
    })

    act(() => acceptances.accept("behind", stamp({ [valueAxis]: 1 })))
    act(() => acceptances.accept("missing", stamp({ [missingAxis]: 1 })))
    act(() => acceptances.remove("missing"))
    // Pruned before any canon covered it.
    act(() => acceptances.remove("behind"))
    act(() => acceptances.accept("covered", stamp({ [valueAxis]: 0 })))

    const steps = renders
      .map(({ accepted }) => [...accepted.keys()].join())
      .filter((step, index, all) => index === 0 || step !== all[index - 1])
    expect(steps).toEqual([
      "",
      "behind",
      "behind,missing",
      "behind",
      "",
      "covered",
    ])
    for (const { accepted, status } of renders) {
      const uncovered = [...accepted.values()].some(
        (pending) => !covers(mounted.revisions, pending.revisions)
      )
      expect(status.freshness === "current").toBe(!uncovered)
      expect(status.missingAxes).toEqual(
        accepted.has("missing") ? [missingAxis] : []
      )
    }
  })
})

describe("status in the render that receives canon", () => {
  it.each([
    {
      outstanding: "grace",
      graceMs: ROUTER_ACCEPTANCE_GRACE_MS,
      request: async () => undefined,
      settle: async () => undefined,
    },
    {
      outstanding: "refreshing",
      graceMs: 0,
      request: () => new Promise<void>(() => undefined),
      settle: flushMicrotasks,
    },
    {
      outstanding: "stalled",
      graceMs: 0,
      request: async () => undefined,
      settle: async () => {
        await flushMicrotasks()
        await advance(UNCOVERED_REFRESH_RETRY_MS)
      },
    },
  ])(
    "reports current with no missing axes together while $outstanding",
    async ({ outstanding, graceMs, request, settle }) => {
      const acceptances = testAcceptances()
      const refresh: RefreshAdapter = { acceptanceGraceMs: graceMs, request }
      const renders: IncorporationStatus[] = []
      const { rerender } = renderHook(
        ({ currentCanon }: { readonly currentCanon: Canon<number> }) => {
          const { status } = useIncorporation(
            currentCanon,
            refresh,
            undefined,
            acceptances.source
          )
          renders.push(status)
        },
        { initialProps: { currentCanon: canon(0, 0) } }
      )

      act(() => acceptances.accept("missing", stamp({ [missingAxis]: 1 })))
      await settle()
      expect(renders.at(-1)?.freshness).toBe(outstanding)

      const coveredFrom = renders.length
      rerender({
        currentCanon: {
          value: 0,
          revisions: revisions({ [valueAxis]: 0, [missingAxis]: 1 }),
        },
      })
      await flushMicrotasks()

      expect(renders.length).toBeGreaterThan(coveredFrom)
      for (const status of renders.slice(coveredFrom)) {
        expect(status).toMatchObject({ freshness: "current", missingAxes: [] })
      }
      for (const status of renders) {
        expect(status.freshness === "current").toBe(
          status.missingAxes.length === 0
        )
      }
    }
  )
})

interface ControlledInvalidations {
  readonly adapter: InvalidationAdapter
  readonly subscriptions: InvalidationSubscription[]
}

function controlledInvalidations(): ControlledInvalidations {
  const subscriptions: InvalidationSubscription[] = []
  return {
    subscriptions,
    adapter: {
      initialStatus: "active",
      subscribe(subscription) {
        subscriptions.push(subscription)
        return () => undefined
      },
    },
  }
}

describe("createObservedRoot", () => {
  it("exposes watch-only value and status without a mutation surface", async () => {
    const invalidations = controlledInvalidations()
    const request = vi.fn()
    const adapter: RefreshAdapter = { acceptanceGraceMs: 0, request }
    function useRefresh() {
      return adapter
    }
    const useObserved = createObservedRoot({
      refresh: useRefresh,
      invalidations: invalidations.adapter,
    })
    const { result } = renderHook(() => useObserved({ canon: canon(7, 0) }))

    expect(result.current.value).toBe(7)
    expect(result.current.status).toMatchObject({
      freshness: "current",
      invalidations: "active",
    })
    expect("mutate" in result.current).toBe(false)
    expect(invalidations.subscriptions[0]?.axes).toEqual([valueAxis])

    act(() =>
      invalidations.subscriptions[0]?.onInvalidation({
        eventId: "event-1",
        axis: valueAxis,
        revision: 1 as Revision,
      })
    )
    await flushMicrotasks()

    expect(request).toHaveBeenCalledOnce()
    expect(result.current.status.freshness).toBe("refreshing")
  })

  it("ignores old and unrelated invalidations", async () => {
    const invalidations = controlledInvalidations()
    const request = vi.fn()
    const adapter: RefreshAdapter = { acceptanceGraceMs: 0, request }
    function useRefresh() {
      return adapter
    }
    const useObserved = createObservedRoot({
      refresh: useRefresh,
      invalidations: invalidations.adapter,
    })
    renderHook(() => useObserved({ canon: canon(7, 2) }))

    const subscription = invalidations.subscriptions[0]
    act(() => {
      subscription?.onInvalidation({
        eventId: "old",
        axis: valueAxis,
        revision: 2 as Revision,
      })
      subscription?.onInvalidation({
        eventId: "unrelated",
        axis: missingAxis,
        revision: 10 as Revision,
      })
    })
    await flushMicrotasks()

    expect(request).not.toHaveBeenCalled()
  })

  it("coalesces post-attachment gap recovery even when canon appears current", async () => {
    const invalidations = controlledInvalidations()
    const request = vi.fn(async () => undefined)
    const adapter: RefreshAdapter = { acceptanceGraceMs: 0, request }
    function useRefresh() {
      return adapter
    }
    const useObserved = createObservedRoot({
      refresh: useRefresh,
      invalidations: invalidations.adapter,
    })
    const rendered = renderHook(() => useObserved({ canon: canon(7, 2) }))

    act(() => {
      invalidations.subscriptions[0]?.onSubscriptionGap?.()
      invalidations.subscriptions[0]?.onSubscriptionGap?.()
    })
    await flushMicrotasks()

    expect(request).toHaveBeenCalledOnce()
    expect(rendered.result.current.status.freshness).toBe("current")
  })

  it("tracks unrestricted axis IDs without dependency-key collisions", () => {
    const invalidations = controlledInvalidations()
    const adapter: RefreshAdapter = {
      acceptanceGraceMs: 0,
      request: () => undefined,
    }
    function useRefresh() {
      return adapter
    }
    const useObserved = createObservedRoot({
      refresh: useRefresh,
      invalidations: invalidations.adapter,
    })
    const { rerender } = renderHook(
      ({ currentCanon }: { readonly currentCanon: Canon<number> }) =>
        useObserved({ canon: currentCanon }),
      {
        initialProps: {
          currentCanon: {
            value: 0,
            revisions: revisions({ a: 0, b: 0 }),
          },
        },
      }
    )

    expect(invalidations.subscriptions[0]?.axes).toEqual([
      axisId("a"),
      axisId("b"),
    ])

    rerender({
      currentCanon: {
        value: 0,
        revisions: revisions({ "a\u0000b": 0 }),
      },
    })

    expect(invalidations.subscriptions[1]?.axes).toEqual([axisId("a\u0000b")])
  })

  it("coalesces a burst after merging every fresher observation", async () => {
    const invalidations = controlledInvalidations()
    const request = vi.fn()
    const adapter: RefreshAdapter = { acceptanceGraceMs: 0, request }
    function useRefresh() {
      return adapter
    }
    const useObserved = createObservedRoot({
      refresh: useRefresh,
      invalidations: invalidations.adapter,
    })
    renderHook(() => useObserved({ canon: canon(0, 0) }))
    const subscription = invalidations.subscriptions[0]

    act(() => {
      subscription?.onInvalidation({
        eventId: "shared-event",
        axis: valueAxis,
        revision: 1 as Revision,
      })
      subscription?.onInvalidation({
        eventId: "shared-event",
        axis: valueAxis,
        revision: 2 as Revision,
      })
    })
    await flushMicrotasks()

    expect(request).toHaveBeenCalledOnce()
  })

  it("resets a stalled budget only for a genuinely fresher invalidation", async () => {
    const invalidations = controlledInvalidations()
    const request = vi.fn(async () => undefined)
    const adapter: RefreshAdapter = { acceptanceGraceMs: 0, request }
    function useRefresh() {
      return adapter
    }
    const useObserved = createObservedRoot({
      refresh: useRefresh,
      invalidations: invalidations.adapter,
    })
    const { result } = renderHook(() => useObserved({ canon: canon(0, 0) }))
    const subscription = invalidations.subscriptions[0]
    const invalidate = (revision: number, eventId: string) =>
      subscription?.onInvalidation({
        eventId,
        axis: valueAxis,
        revision: revision as Revision,
      } satisfies AxisInvalidation)

    act(() => invalidate(1, "first"))
    await flushMicrotasks()
    await advance(UNCOVERED_REFRESH_RETRY_MS)
    expect(result.current.status.freshness).toBe("stalled")
    expect(request).toHaveBeenCalledTimes(2)

    act(() => invalidate(1, "duplicate"))
    await flushMicrotasks()
    expect(request).toHaveBeenCalledTimes(2)

    act(() => invalidate(2, "fresher"))
    await flushMicrotasks()
    expect(request).toHaveBeenCalledTimes(3)
    expect(result.current.status.freshness).toBe("refreshing")
  })
})

describe("subscription gaps", () => {
  function setupGap(request: () => void | Promise<void>) {
    const invalidations = controlledInvalidations()
    const refresh: RefreshAdapter = { acceptanceGraceMs: 0, request }
    const rendered = renderHook(() =>
      useIncorporation(canon(0, 0), refresh, invalidations.adapter)
    )
    const signalGap = () =>
      act(() => invalidations.subscriptions[0]?.onSubscriptionGap?.())
    return { ...rendered, signalGap }
  }

  it("keeps a gap open after a failed refresh and retries it on request", async () => {
    const request = vi.fn(async () => {
      throw new Error("refresh failed")
    })
    const { result, signalGap } = setupGap(request)

    signalGap()
    await flushMicrotasks()
    expect(request).toHaveBeenCalledOnce()
    expect(result.current.status.freshness).not.toBe("current")

    act(() => result.current.retryRefresh())
    await flushMicrotasks()
    expect(request).toHaveBeenCalledTimes(2)
    expect(result.current.status.freshness).not.toBe("current")
  })

  it("bounds gap refreshes by the attempt budget and recovers on retry", async () => {
    let fail = true
    const request = vi.fn(async () => {
      if (fail) throw new Error("refresh failed")
    })
    const { result, signalGap } = setupGap(request)

    signalGap()
    await flushMicrotasks()
    await advance(UNCOVERED_REFRESH_RETRY_MS)
    expect(request).toHaveBeenCalledTimes(2)
    expect(result.current.status).toMatchObject({
      freshness: "stalled",
      stallReason: "refresh-error",
    })

    // The open gap is the same requirement: repeating it buys no new budget.
    signalGap()
    await advance(5 * UNCOVERED_REFRESH_RETRY_MS)
    expect(request).toHaveBeenCalledTimes(2)
    expect(result.current.status.freshness).toBe("stalled")

    fail = false
    act(() => result.current.retryRefresh())
    await flushMicrotasks()
    expect(request).toHaveBeenCalledTimes(3)
    expect(result.current.status.freshness).toBe("current")
  })

  it("does not let a refresh that started before a gap close it", async () => {
    const completions: Array<() => void> = []
    const request = vi.fn(
      () => new Promise<void>((resolve) => completions.push(resolve))
    )
    const { result, signalGap } = setupGap(request)

    signalGap()
    await flushMicrotasks()
    signalGap()
    act(() => completions.shift()?.())
    await flushMicrotasks()

    expect(request).toHaveBeenCalledTimes(2)
    expect(result.current.status.freshness).toBe("refreshing")
    act(() => completions.shift()?.())
    await flushMicrotasks()
    expect(result.current.status.freshness).toBe("current")
  })
})

// Moved from the invalidation adapter contract: these exercise how
// useIncorporation consumes invalidations, which does not vary by adapter.
describe("incorporation of published invalidations", () => {
  const axisA = axisId("refresh/published/a")
  const axisB = axisId("refresh/published/b")

  function twoAxisCanon(a: number, b: number) {
    return {
      value: { a, b },
      revisions: revisions({ [axisA]: a, [axisB]: b }),
    }
  }

  it("ingests every axis in one event before requesting one coalesced refresh", async () => {
    const invalidations = createInMemoryInvalidationAdapter()
    const request = vi.fn(async () => undefined)
    const refresh: RefreshAdapter = { acceptanceGraceMs: 0, request }
    const rendered = renderHook(
      ({
        currentCanon,
      }: {
        readonly currentCanon: ReturnType<typeof twoAxisCanon>
      }) => useIncorporation(currentCanon, refresh, invalidations),
      { initialProps: { currentCanon: twoAxisCanon(0, 0) } }
    )
    await flushMicrotasks()
    request.mockClear()

    act(() =>
      invalidations.publish("shared-event", stamp({ [axisA]: 1, [axisB]: 1 }))
    )
    await flushMicrotasks()
    expect(request).toHaveBeenCalledTimes(1)

    rendered.rerender({ currentCanon: twoAxisCanon(1, 0) })
    await flushMicrotasks()
    await advance(UNCOVERED_REFRESH_RETRY_MS)

    expect(request).toHaveBeenCalledTimes(2)
    rendered.unmount()
  })

  it("deduplicates duplicate and older revisions monotonically per axis", async () => {
    const invalidations = createInMemoryInvalidationAdapter()
    const request = vi.fn(async () => undefined)
    const refresh: RefreshAdapter = { acceptanceGraceMs: 0, request }
    const rendered = renderHook(() =>
      useIncorporation(twoAxisCanon(0, 0), refresh, invalidations)
    )
    await flushMicrotasks()
    request.mockClear()

    act(() => {
      invalidations.publish("newest", stamp({ [axisA]: 2 }))
      invalidations.publish("duplicate", stamp({ [axisA]: 2 }))
      invalidations.publish("older", stamp({ [axisA]: 1 }))
    })
    await flushMicrotasks()

    expect(request).toHaveBeenCalledTimes(1)
    rendered.unmount()
  })
})

// Moved from the former public `verifyPollingFallbackContract`.
describe("polling fallback", () => {
  let visibility: DocumentVisibilityState
  let originalVisibility: PropertyDescriptor | undefined

  const setVisibility = (next: DocumentVisibilityState) => {
    visibility = next
    document.dispatchEvent(new Event("visibilitychange"))
  }

  beforeEach(() => {
    visibility = "visible"
    originalVisibility = Object.getOwnPropertyDescriptor(
      document,
      "visibilityState"
    )
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    })
  })

  afterEach(() => {
    if (originalVisibility) {
      Object.defineProperty(document, "visibilityState", originalVisibility)
    } else {
      Reflect.deleteProperty(document, "visibilityState")
    }
  })

  it("reports polling and serializes refreshes while the primary is unavailable", async () => {
    const primary = createInMemoryInvalidationAdapter()
    primary.setStatus("unavailable")
    const invalidations = withPollingFallback(primary, { intervalMs: 100 })
    const completions: Array<() => void> = []
    const request = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          completions.push(resolve)
        })
    )
    const refresh: RefreshAdapter = { acceptanceGraceMs: 0, request }
    const rendered = renderHook(() =>
      useIncorporation(canon(0, 0), refresh, invalidations)
    )

    expect(rendered.result.current.status.invalidations).toBe("polling")
    await advance(400)
    expect(request).toHaveBeenCalledTimes(1)

    act(() => completions.shift()?.())
    await flushMicrotasks()
    expect(request).toHaveBeenCalledTimes(2)

    // Ticks while the second refresh runs are gaps it cannot close: they may
    // stand for invalidations missed before recovery. So one more refresh
    // follows even though the primary is active again, and then polling stops.
    await advance(400)
    act(() => primary.setStatus("active"))
    act(() => completions.shift()?.())
    await flushMicrotasks()
    expect(request).toHaveBeenCalledTimes(3)
    act(() => completions.shift()?.())
    await advance(400)
    expect(request).toHaveBeenCalledTimes(3)
    expect(rendered.result.current.status.freshness).toBe("current")
    rendered.unmount()
  })

  it("pauses while hidden and refreshes immediately when visibility resumes", async () => {
    const primary = createInMemoryInvalidationAdapter()
    primary.setStatus("unavailable")
    setVisibility("hidden")
    const request = vi.fn(async () => undefined)
    const refresh: RefreshAdapter = { acceptanceGraceMs: 0, request }
    const rendered = renderHook(() =>
      useIncorporation(
        canon(0, 0),
        refresh,
        withPollingFallback(primary, { intervalMs: 100 })
      )
    )

    await advance(500)
    expect(request).not.toHaveBeenCalled()

    act(() => setVisibility("visible"))
    await flushMicrotasks()
    expect(request).toHaveBeenCalledTimes(1)

    await advance(100)
    expect(request).toHaveBeenCalledTimes(2)

    act(() => setVisibility("hidden"))
    await advance(500)
    expect(request).toHaveBeenCalledTimes(2)
    rendered.unmount()
  })

  it("polls during initial reauthorization and stops when the primary recovers", async () => {
    const primary = createInMemoryInvalidationAdapter()
    primary.setStatus("reauthorizing")
    const request = vi.fn(async () => undefined)
    const refresh: RefreshAdapter = { acceptanceGraceMs: 0, request }
    const rendered = renderHook(() =>
      useIncorporation(
        canon(0, 0),
        refresh,
        withPollingFallback(primary, { intervalMs: 100 })
      )
    )

    expect(rendered.result.current.status.invalidations).toBe("polling")
    await advance(100)
    expect(request).toHaveBeenCalledTimes(1)

    act(() => primary.setStatus("active"))
    expect(rendered.result.current.status.invalidations).toBe("active")
    await advance(500)
    expect(request).toHaveBeenCalledTimes(1)
    rendered.unmount()
  })

  it("supports intentional no-realtime roots and cancels on unmount", async () => {
    const request = vi.fn(async () => undefined)
    const refresh: RefreshAdapter = { acceptanceGraceMs: 0, request }
    const invalidations = withPollingFallback(
      createNoRealtimeInvalidationAdapter(),
      { intervalMs: 100 }
    )
    const rendered = renderHook(() =>
      useIncorporation(canon(0, 0), refresh, invalidations)
    )

    expect(rendered.result.current.status.invalidations).toBe("polling")
    rendered.unmount()
    await advance(500)
    act(() => setVisibility("hidden"))
    act(() => setVisibility("visible"))
    await flushMicrotasks()
    expect(request).not.toHaveBeenCalled()
  })
})
