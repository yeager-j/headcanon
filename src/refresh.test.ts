// @vitest-environment jsdom

import type { StandardSchemaV1 } from "@standard-schema/spec"
import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ok, type Result } from "@workspace/result"

import {
  acceptedStamp,
  axisId,
  defineMutation,
  defineProtocol,
  revisionVector,
  type AcceptedStamp,
  type Canon,
  type Revision,
} from "./index"
import {
  createObservedRoot,
  createPredictedRoot,
  useSnapshotRefresh,
  type AxisInvalidation,
  type InvalidationAdapter,
  type InvalidationSubscription,
  type MutationEnvelope,
  type RefreshAdapter,
} from "./react"
import { verifyRefreshContract } from "./testing"

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
  return acceptedStamp(revisions(entries))
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
    return { acceptanceGraceMs: 250, request }
  },
})
verifyRefreshContract({
  name: "snapshot-shaped",
  completion: "request",
  useRefresh(request) {
    return {
      acceptanceGraceMs: 0,
      request: async () => request(),
    }
  },
})

describe("refresh incorporation", () => {
  it("uses acceptance grace only for the router-shaped carrier", async () => {
    const router = setupPredictedRefresh({ acceptanceGraceMs: 250 })
    await flushMicrotasks()

    expect(router.result.current.status.freshness).toBe("grace")
    expect(router.request).not.toHaveBeenCalled()
    await advance(249)
    expect(router.request).not.toHaveBeenCalled()
    await advance(1)
    expect(router.request).toHaveBeenCalledOnce()
    router.unmount()

    const snapshot = setupPredictedRefresh({ acceptanceGraceMs: 0 })
    await flushMicrotasks()
    expect(snapshot.request).toHaveBeenCalledOnce()
    expect(snapshot.result.current.status.freshness).toBe("refreshing")
  })

  it("waits for a void carrier to deliver canon before consuming an attempt", async () => {
    const { request, result, rerender } = setupPredictedRefresh({
      acceptanceGraceMs: 0,
      request: () => undefined,
    })
    await flushMicrotasks()

    expect(request).toHaveBeenCalledOnce()
    await advance(5_000)
    expect(request).toHaveBeenCalledOnce()
    expect(result.current.status.freshness).toBe("refreshing")

    rerender({ currentCanon: canon(0, 0) })
    await flushMicrotasks()
    await advance(999)
    expect(request).toHaveBeenCalledOnce()
    await advance(1)
    expect(request).toHaveBeenCalledTimes(2)
    expect(result.current.status.freshness).toBe("refreshing")

    rerender({ currentCanon: canon(0, 0) })
    await flushMicrotasks()
    expect(result.current.status).toMatchObject({
      freshness: "stalled",
      stallReason: "behind",
    })
  })

  it("deduplicates an own-write invalidation against recorded acceptance", async () => {
    const invalidations = controlledInvalidations()
    const { request, result } = setupPredictedRefresh({
      acceptanceGraceMs: 250,
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
    await advance(1_000)

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

    await advance(1_000)

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
    await advance(1_000)

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
            revisions: revisions({ "": 0, a: 0, b: 0 }),
          },
        },
      }
    )

    expect(invalidations.subscriptions[0]?.axes).toEqual([
      axisId(""),
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
    await advance(1_000)
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
