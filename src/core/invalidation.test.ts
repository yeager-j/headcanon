import { describe, expect, it } from "vitest"

import {
  axisInvalidation,
  createLazyInvalidationAdapter,
  createNoRealtimeInvalidationAdapter,
  isDegradedInvalidationStatus,
  type InvalidationAdapter,
  type InvalidationStatus,
  type InvalidationSubscription,
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

describe("createLazyInvalidationAdapter", () => {
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
    const adapter = createLazyInvalidationAdapter({
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
    const adapter = createLazyInvalidationAdapter({
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
    const adapter = createLazyInvalidationAdapter({
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
    const adapter = createLazyInvalidationAdapter({
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
    const adapter = createLazyInvalidationAdapter({
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
    const adapter = createLazyInvalidationAdapter({
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
      const adapter = createLazyInvalidationAdapter({
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
