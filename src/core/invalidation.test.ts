import { describe, expect, expectTypeOf, it, vi } from "vitest"

import {
  axisInvalidation,
  createNoRealtimeInvalidationAdapter,
  createRestartableLazyAdapter,
  isDegradedInvalidationStatus,
  withPollingFallback,
  withVisibilityRefresh,
  type InvalidationAdapter,
  type InvalidationStatus,
  type InvalidationSubscription,
  type RetryableInvalidationAdapter,
} from "./invalidation"
import { axisId } from "./revisions"

describe("axisInvalidation", () => {
  it("parses exactly one singleton axis revision", () => {
    expect(
      axisInvalidation({
        eventId: "event-1",
        axis: "entity/one",
        revision: 3,
      })
    ).toEqual({
      ok: true,
      value: {
        eventId: "event-1",
        axis: axisId("entity/one"),
        revision: 3,
      },
    })
  })

  it.each([
    null,
    [],
    { eventId: "event-1", axis: "entity/one", revision: 1, hp: 10 },
    { eventId: "", axis: "entity/one", revision: 1 },
    { eventId: "event-1", axis: "", revision: 1 },
    { eventId: "event-1", axis: "entity/one", revision: -1 },
    { eventId: "event-1", axis: "entity/one", revision: 1.5 },
    { eventId: "event-1", axis: "entity/one", revision: "1" },
  ])("rejects malformed or domain-bearing payload %#", (payload) => {
    expect(axisInvalidation(payload).ok).toBe(false)
  })

  it("rejects hidden and symbol-keyed domain data", () => {
    const hidden = { eventId: "event-1", axis: "entity/one", revision: 1 }
    Object.defineProperty(hidden, "hp", { value: 10 })
    const symbol = {
      eventId: "event-1",
      axis: "entity/one",
      revision: 1,
      [Symbol("hp")]: 10,
    }

    expect(axisInvalidation(hidden).ok).toBe(false)
    expect(axisInvalidation(symbol).ok).toBe(false)
  })

  it("nests an invalid revision's error under its own code", () => {
    const payload = { eventId: "event-1", axis: "entity/one", revision: -1 }

    expect(axisInvalidation(payload)).toEqual({
      ok: false,
      error: {
        code: "invalid-axis-invalidation",
        reason: "invalid-revision",
        value: payload,
        error: { code: "invalid-revision", reason: "negative", value: -1 },
      },
    })
  })
})

describe("isDegradedInvalidationStatus", () => {
  it.each([
    ["disabled", true],
    ["reauthorizing", true],
    ["unavailable", true],
    ["active", false],
    ["polling", false],
  ] as const)("classifies %s as degraded: %s", (status, degraded) => {
    expect(isDegradedInvalidationStatus(status)).toBe(degraded)
  })
})

describe("createNoRealtimeInvalidationAdapter", () => {
  it("reports disabled and never delivers", () => {
    const statuses: InvalidationStatus[] = []
    const adapter = createNoRealtimeInvalidationAdapter()

    expect(adapter.initialStatus).toBe("disabled")
    const unsubscribe = adapter.subscribe({
      ...subscription(statuses),
      onInvalidation: () => {
        throw new Error("no-realtime adapter delivered an invalidation")
      },
    })
    unsubscribe()

    expect(statuses).toEqual(["disabled"])
  })
})

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}

/** Lets a pending lazy initialize() settle and forward buffered subscriptions. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function subscription(
  statuses: InvalidationStatus[]
): InvalidationSubscription {
  return {
    axes: [axisId("axis-1")],
    onInvalidation: () => undefined,
    onStatusChange: (status) => statuses.push(status),
  }
}

describe("createRestartableLazyAdapter before a restart", () => {
  const transportError = new Error("transport failed")

  it("initializes once and forwards buffered and ready subscriptions", async () => {
    const readiness = deferred<InvalidationAdapter | null>()
    const subscribed: InvalidationSubscription[] = []
    let initializeCount = 0
    const inner: InvalidationAdapter = {
      initialStatus: "active",
      subscribe(value) {
        subscribed.push(value)
        return () => undefined
      },
    }
    const adapter = createRestartableLazyAdapter({
      initialize: () => {
        initializeCount += 1
        return readiness.promise
      },
    })

    adapter.subscribe(subscription([]))
    adapter.subscribe(subscription([]))
    expect(initializeCount).toBe(1)
    expect(subscribed).toHaveLength(0)

    readiness.resolve(inner)
    await flushMicrotasks()
    adapter.subscribe(subscription([]))

    expect(subscribed).toHaveLength(3)
    expect(initializeCount).toBe(1)
  })

  it("does not forward a subscription cancelled before readiness", async () => {
    const readiness = deferred<InvalidationAdapter | null>()
    const subscribed: InvalidationSubscription[] = []
    const adapter = createRestartableLazyAdapter({
      initialize: () => readiness.promise,
    })
    const unsubscribe = adapter.subscribe(subscription([]))

    unsubscribe()
    readiness.resolve({
      initialStatus: "active",
      subscribe(value) {
        subscribed.push(value)
        return () => undefined
      },
    })
    await flushMicrotasks()

    expect(subscribed).toHaveLength(0)
  })

  it("forwards the inner adapter's status after readiness", async () => {
    const readiness = deferred<InvalidationAdapter | null>()
    const statuses: InvalidationStatus[] = []
    // A valid inner adapter that reports changes only, never its start status.
    const inner: InvalidationAdapter = {
      initialStatus: "active",
      subscribe: () => () => undefined,
    }
    const adapter = createRestartableLazyAdapter({
      initialize: () => readiness.promise,
    })

    expect(adapter.initialStatus).toBe("reauthorizing")
    adapter.subscribe(subscription(statuses))
    readiness.resolve(inner)
    await flushMicrotasks()

    expect(statuses).toEqual(["active"])
    expect(adapter.initialStatus).toBe("active")
  })

  it("reads the inner adapter's status at subscribe time", async () => {
    let innerStatus: InvalidationStatus = "active"
    const adapter = createRestartableLazyAdapter({
      initialize: () =>
        Promise.resolve({
          get initialStatus() {
            return innerStatus
          },
          subscribe: () => () => undefined,
        }),
    })

    adapter.subscribe(subscription([]))
    await flushMicrotasks()
    innerStatus = "unavailable"

    expect(adapter.initialStatus).toBe("unavailable")
  })

  it("releases the inner subscription when unsubscribed after readiness", async () => {
    const released: string[] = []
    const adapter = createRestartableLazyAdapter({
      initialize: () =>
        Promise.resolve({
          initialStatus: "active",
          subscribe: () => () => released.push("inner"),
        }),
    })

    const buffered = adapter.subscribe(subscription([]))
    await flushMicrotasks()
    const direct = adapter.subscribe(subscription([]))
    buffered()
    direct()

    expect(released).toEqual(["inner", "inner"])
  })

  it("does not subscribe when the forwarded status cancels the subscription", async () => {
    const subscribed: InvalidationSubscription[] = []
    const adapter = createRestartableLazyAdapter({
      initialize: () =>
        Promise.resolve({
          initialStatus: "active",
          subscribe(value) {
            subscribed.push(value)
            return () => undefined
          },
        }),
    })
    let unsubscribe: () => void = () => undefined
    unsubscribe = adapter.subscribe({
      ...subscription([]),
      onStatusChange: () => unsubscribe(),
    })
    await flushMicrotasks()

    expect(subscribed).toHaveLength(0)
  })

  it.each([
    {
      outcome: "resolves null",
      initialize: () => Promise.resolve(null),
      reported: [],
    },
    {
      outcome: "rejects",
      initialize: () => Promise.reject(transportError),
      reported: [transportError],
    },
  ])(
    "reports unavailable when initialization $outcome",
    async ({ initialize, reported }) => {
      const statuses: InvalidationStatus[] = []
      const errors: unknown[] = []
      const adapter = createRestartableLazyAdapter({
        initialize,
        onInitializationError: (value) => errors.push(value),
      })

      adapter.subscribe(subscription(statuses))
      await flushMicrotasks()
      adapter.subscribe(subscription(statuses))

      expect(statuses).toEqual(["unavailable", "unavailable"])
      expect(adapter.initialStatus).toBe("unavailable")
      expect(errors).toEqual(reported)
    }
  )
})

describe("createRestartableLazyAdapter restart", () => {
  function innerAdapter(subscribed: InvalidationSubscription[]) {
    return {
      initialStatus: "active",
      subscribe(value) {
        subscribed.push(value)
        return () => undefined
      },
    } satisfies InvalidationAdapter
  }

  it("restarts a failed initialization and forwards every waiting subscription once", async () => {
    const subscribed: InvalidationSubscription[] = []
    const initialize = vi
      .fn<() => Promise<InvalidationAdapter | null>>()
      .mockRejectedValueOnce(new Error("transport failed"))
      .mockResolvedValueOnce(innerAdapter(subscribed))
    const adapter = createRestartableLazyAdapter({ initialize })
    const early: InvalidationStatus[] = []
    const late: InvalidationStatus[] = []

    adapter.subscribe(subscription(early))
    await flushMicrotasks()
    adapter.subscribe(subscription(late))
    expect(adapter.initialStatus).toBe("unavailable")

    expect(adapter.restart()).toBe(true)
    await flushMicrotasks()

    expect(initialize).toHaveBeenCalledTimes(2)
    expect(subscribed).toHaveLength(2)
    expect(early).toEqual(["unavailable", "reauthorizing", "active"])
    expect(late).toEqual(["unavailable", "reauthorizing", "active"])
  })

  it("does not forward a subscription cancelled while unavailable", async () => {
    const subscribed: InvalidationSubscription[] = []
    const initialize = vi
      .fn<() => Promise<InvalidationAdapter | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(innerAdapter(subscribed))
    const adapter = createRestartableLazyAdapter({ initialize })

    const unsubscribe = adapter.subscribe(subscription([]))
    await flushMicrotasks()
    unsubscribe()
    adapter.restart()
    await flushMicrotasks()

    expect(subscribed).toHaveLength(0)
  })

  it("restarts only when unavailable", async () => {
    const readiness = deferred<InvalidationAdapter | null>()
    const initialize = vi.fn(() => readiness.promise)
    const adapter = createRestartableLazyAdapter({ initialize })

    expect(adapter.restart()).toBe(false)
    adapter.subscribe(subscription([]))
    expect(adapter.restart()).toBe(false)
    readiness.resolve(innerAdapter([]))
    await flushMicrotasks()

    expect(adapter.restart()).toBe(false)
    expect(initialize).toHaveBeenCalledOnce()
  })

  it("moves every subscription to the next transport when a forward fails part-way", async () => {
    const released: string[] = []
    let forwards = 0
    const failing: InvalidationAdapter = {
      initialStatus: "active",
      subscribe() {
        forwards += 1
        if (forwards === 2) throw new Error("forward failed")
        return () => released.push("first transport")
      },
    }
    const next: InvalidationSubscription[] = []
    const initialize = vi
      .fn<() => Promise<InvalidationAdapter | null>>()
      .mockResolvedValueOnce(failing)
      .mockResolvedValueOnce(innerAdapter(next))
    const adapter = createRestartableLazyAdapter({
      initialize,
      onInitializationError: () => undefined,
    })
    const first: InvalidationStatus[] = []
    const second: InvalidationStatus[] = []

    adapter.subscribe(subscription(first))
    adapter.subscribe(subscription(second))
    await flushMicrotasks()

    expect(released).toEqual(["first transport"])
    expect(first).toEqual(["active", "unavailable"])
    expect(second).toEqual(["active", "unavailable"])

    adapter.restart()
    await flushMicrotasks()

    expect(next).toHaveLength(2)
  })

  /** A transport that tracks live subscriptions and refuses one of them. */
  function trackingTransport(refuse?: InvalidationSubscription) {
    const live = new Set<InvalidationSubscription>()
    const adapter: InvalidationAdapter = {
      initialStatus: "active",
      subscribe(value) {
        if (value === refuse) throw new Error("forward failed")
        live.add(value)
        return () => live.delete(value)
      },
    }
    return { adapter, live }
  }

  it("rolls back a subscription made by a status callback during forwarding", async () => {
    const lateStatuses: InvalidationStatus[] = []
    const late = subscription(lateStatuses)
    const failing = subscription([])
    const first = trackingTransport(failing)
    const next = trackingTransport()
    const initialize = vi
      .fn<() => Promise<InvalidationAdapter | null>>()
      .mockResolvedValueOnce(first.adapter)
      .mockResolvedValueOnce(next.adapter)
    const adapter = createRestartableLazyAdapter({
      initialize,
      onInitializationError: () => undefined,
    })
    let subscribedLate = false
    const early: InvalidationSubscription = {
      ...subscription([]),
      onStatusChange: () => {
        if (subscribedLate) return
        subscribedLate = true
        adapter.subscribe(late)
      },
    }

    adapter.subscribe(early)
    adapter.subscribe(failing)
    await flushMicrotasks()
    expect(first.live.size).toBe(0)

    adapter.restart()
    await flushMicrotasks()

    expect(first.live.size).toBe(0)
    expect(next.live).toEqual(new Set([early, failing, late]))
  })

  it("releases a subscription cancelled during forwarding exactly once", async () => {
    const releases = vi.fn()
    let cancelEarly: () => void = () => undefined
    const failing: InvalidationSubscription = {
      ...subscription([]),
      onStatusChange: () => cancelEarly(),
    }
    const adapter = createRestartableLazyAdapter({
      initialize: () =>
        Promise.resolve({
          initialStatus: "active",
          subscribe(value) {
            if (value === failing) throw new Error("forward failed")
            return releases
          },
        }),
      onInitializationError: () => undefined,
    })

    cancelEarly = adapter.subscribe(subscription([]))
    adapter.subscribe(failing)
    await flushMicrotasks()

    expect(releases).toHaveBeenCalledOnce()
    expect(adapter.initialStatus).toBe("unavailable")
  })

  it("finishes a rollback when a release throws", async () => {
    const failing = subscription([])
    const errors: unknown[] = []
    const releaseError = new Error("release failed")
    const adapter = createRestartableLazyAdapter({
      initialize: () =>
        Promise.resolve({
          initialStatus: "active",
          subscribe(value) {
            if (value === failing) throw new Error("forward failed")
            return () => {
              throw releaseError
            }
          },
        }),
      onInitializationError: (error) => errors.push(error),
    })
    const statuses: InvalidationStatus[] = []

    adapter.subscribe(subscription(statuses))
    adapter.subscribe(failing)
    await flushMicrotasks()

    expect(errors).toContain(releaseError)
    expect(statuses).toEqual(["active", "unavailable"])
    expect(adapter.restart()).toBe(true)
  })

  it("sends no stale unavailable after a status callback restarts", async () => {
    const initialize = vi
      .fn<() => Promise<InvalidationAdapter | null>>()
      .mockResolvedValueOnce(null)
      .mockReturnValueOnce(new Promise(() => undefined))
    const adapter = createRestartableLazyAdapter({ initialize })
    const second: InvalidationStatus[] = []

    adapter.subscribe({
      ...subscription([]),
      onStatusChange: (status) => {
        if (status === "unavailable") adapter.restart()
      },
    })
    adapter.subscribe(subscription(second))
    await flushMicrotasks()

    expect(second).toEqual(["reauthorizing"])
    expect(adapter.initialStatus).toBe("reauthorizing")
  })
})

describe("withPollingFallback retry", () => {
  it("forwards retry() from a retryable primary", () => {
    const retry = vi.fn()
    const primary: RetryableInvalidationAdapter = {
      ...createNoRealtimeInvalidationAdapter(),
      retry,
    }

    const wrapped = withPollingFallback(primary, { intervalMs: 100 })
    wrapped.retry()

    expectTypeOf(wrapped).toEqualTypeOf<RetryableInvalidationAdapter>()
    expect(retry).toHaveBeenCalledOnce()
  })

  it("adds no retry() to a primary without one", () => {
    const wrapped = withPollingFallback(createNoRealtimeInvalidationAdapter(), {
      intervalMs: 100,
    })

    expectTypeOf(wrapped).toEqualTypeOf<InvalidationAdapter>()
    expect("retry" in wrapped).toBe(false)
  })
})

describe("withVisibilityRefresh", () => {
  it("forwards retry() from a retryable primary", () => {
    const retry = vi.fn()
    const primary: RetryableInvalidationAdapter = {
      ...createNoRealtimeInvalidationAdapter(),
      retry,
    }

    const wrapped = withVisibilityRefresh(primary)
    wrapped.retry()

    expectTypeOf(wrapped).toEqualTypeOf<RetryableInvalidationAdapter>()
    expect(retry).toHaveBeenCalledOnce()
  })

  it("adds no retry() to a primary without one", () => {
    const wrapped = withVisibilityRefresh(createNoRealtimeInvalidationAdapter())

    expectTypeOf(wrapped).toEqualTypeOf<InvalidationAdapter>()
    expect("retry" in wrapped).toBe(false)
  })

  it("passes subscriptions through where there is no document", () => {
    const stop = vi.fn()
    let status: InvalidationStatus = "reauthorizing"
    const subscribe = vi.fn(() => stop)
    const wrapped = withVisibilityRefresh({
      get initialStatus() {
        return status
      },
      subscribe,
    })
    const subscription: InvalidationSubscription = {
      axes: [axisId("entity/one")],
      onInvalidation: vi.fn(),
      onStatusChange: vi.fn(),
    }

    expect(wrapped.subscribe(subscription)).toBe(stop)
    expect(subscribe).toHaveBeenCalledExactlyOnceWith(subscription)
    status = "active"
    expect(wrapped.initialStatus).toBe("active")
  })
})
