import { describe, expect, it } from "vitest"

import {
  axisInvalidation,
  createLazyInvalidationAdapter,
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
    await readiness.promise
    await Promise.resolve()
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
    await readiness.promise
    await Promise.resolve()

    expect(subscribed).toHaveLength(0)
  })

  it.each(["unavailable", "rejected"] as const)(
    "reports unavailable when initialization is %s",
    async (outcome) => {
      const statuses: InvalidationStatus[] = []
      const error = new Error("transport failed")
      const errors: unknown[] = []
      const adapter = createLazyInvalidationAdapter({
        initialize: () =>
          outcome === "unavailable"
            ? Promise.resolve(null)
            : Promise.reject(error),
        onInitializationError: (value) => errors.push(value),
      })

      adapter.subscribe(subscription(statuses))
      await Promise.resolve()
      await Promise.resolve()
      adapter.subscribe(subscription(statuses))

      expect(statuses).toEqual(["unavailable", "unavailable"])
      expect(errors).toEqual(outcome === "rejected" ? [error] : [])
    }
  )
})
