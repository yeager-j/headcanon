// @vitest-environment jsdom

import type { Realtime, Rest } from "ably"
import { describe, expect, it, vi } from "vitest"

import {
  axisInvalidation,
  type AxisInvalidation,
  type InvalidationSubscription,
} from "../invalidation"
import { acceptedStamp, axisId, revisionVector } from "../revisions"
import {
  verifyInvalidationContract,
  type InvalidationContractHarness,
} from "../testing"
import { ABLY_AXIS_INVALIDATION_EVENT, ablyAxisChannelName } from "./channels"
import {
  createAblyInvalidationAdapter,
  type AblyRealtimeChannel,
  type AblyRealtimeClient,
} from "./client"
import { createAblyInvalidationPublisher, type AblyRestClient } from "./server"

class FakeAblyService {
  readonly history: string[] = []
  readonly published: AxisInvalidation[] = []
  readonly failedAttachments = new Set<string>()
  failAuthorization = false
  private authorized = new Set<string>()
  private readonly channelInstances = new Map<string, AblyRealtimeChannel>()
  private readonly deliveries = new Map<
    string,
    Map<string, Set<(message: { readonly data?: unknown }) => void>>
  >()
  private readonly attached = new Set<string>()
  private readonly connectionListeners = new Map<
    string,
    Set<(change: unknown) => void>
  >()
  private readonly connection = {
    state: "initialized",
    on: (
      eventOrEvents: string | string[],
      listener: (change: unknown) => void
    ) => {
      for (const event of Array.isArray(eventOrEvents)
        ? eventOrEvents
        : [eventOrEvents]) {
        const listeners = this.connectionListeners.get(event) ?? new Set()
        listeners.add(listener)
        this.connectionListeners.set(event, listeners)
      }
    },
    off: (
      eventOrEvents: string | string[],
      listener: (change: unknown) => void
    ) => {
      for (const event of Array.isArray(eventOrEvents)
        ? eventOrEvents
        : [eventOrEvents]) {
        this.connectionListeners.get(event)?.delete(listener)
      }
    },
  }

  readonly rest: AblyRestClient = {
    channels: {
      get: (name) => ({
        publish: async (event, data) => {
          this.history.push(`publish:${name}`)
          const parsed = axisInvalidation(data)
          if (parsed.ok) this.published.push(parsed.value)
          this.deliver(name, event, data)
        },
      }),
    },
  }

  readonly realtime: AblyRealtimeClient = {
    auth: {
      authorize: async ({ capability }) => {
        const names = Object.keys(capability)
        this.history.push(`authorize:${names.join(",")}`)
        if (this.failAuthorization) throw new Error("authorization failed")
        this.authorized = new Set(names)
        this.connection.state = "connected"
      },
    },
    channels: {
      get: (name) => this.channel(name),
    },
    connection: this.connection,
  }

  disconnect(): void {
    this.emitConnection("disconnected")
  }

  connect(): void {
    this.emitConnection("connected")
  }

  send(name: string, data: unknown): void {
    this.deliver(name, ABLY_AXIS_INVALIDATION_EVENT, data)
  }

  private deliver(name: string, event: string, data: unknown): void {
    if (!this.attached.has(name)) return
    for (const listener of this.deliveries.get(name)?.get(event) ?? []) {
      listener({ data })
    }
  }

  private emitConnection(state: string): void {
    this.connection.state = state
    for (const listener of this.connectionListeners.get(state) ?? []) {
      listener({ current: state })
    }
  }

  private channel(name: string): AblyRealtimeChannel {
    const existing = this.channelInstances.get(name)
    if (existing) return existing

    const listeners = new Map<
      string,
      Set<(message: { readonly data?: unknown }) => void>
    >()
    this.deliveries.set(name, listeners)
    const channel: AblyRealtimeChannel = {
      subscribe: async (event, listener) => {
        this.history.push(`subscribe:${name}`)
        const eventListeners = listeners.get(event) ?? new Set()
        eventListeners.add(listener)
        listeners.set(event, eventListeners)
      },
      unsubscribe: (event, listener) => {
        this.history.push(`unsubscribe:${name}`)
        listeners.get(event)?.delete(listener)
      },
      attach: async () => {
        this.history.push(`attach:${name}`)
        if (!this.authorized.has(name)) {
          throw new Error(`unauthorized attach: ${name}`)
        }
        if (this.failedAttachments.has(name)) {
          throw new Error(`attach failed: ${name}`)
        }
        this.attached.add(name)
      },
      detach: async () => {
        this.history.push(`detach:${name}`)
        this.attached.delete(name)
      },
    }
    this.channelInstances.set(name, channel)
    return channel
  }
}

function ablyContractHarness(): InvalidationContractHarness {
  return {
    name: "Ably",
    create() {
      const service = new FakeAblyService()
      const adapter = createAblyInvalidationAdapter({
        realtime: service.realtime,
        namespace: "contract",
      })
      return {
        adapter,
        publisher: createAblyInvalidationPublisher({
          rest: service.rest,
          namespace: "contract",
        }),
        published: () => service.published,
        settled: () => adapter.settled(),
      }
    },
  }
}

verifyInvalidationContract(ablyContractHarness())

const axisA = axisId("entity/a")
const axisB = axisId("entity/b")

function subscription(
  axes: readonly (typeof axisA)[],
  overrides: Partial<InvalidationSubscription> = {}
): InvalidationSubscription {
  return {
    axes,
    onInvalidation: vi.fn(),
    onStatusChange: vi.fn(),
    ...overrides,
  }
}

describe("Ably invalidation capability lifecycle", () => {
  it("accepts the official Ably v2 client surfaces", () => {
    const acceptsRealtime = (client: Realtime): AblyRealtimeClient => client
    const restCompatible: Rest extends AblyRestClient ? true : false = true

    expect(acceptsRealtime).toBeTypeOf("function")
    expect(restCompatible).toBe(true)
  })

  it("reauthorizes the exact set before attach and closes the attachment gap", async () => {
    const service = new FakeAblyService()
    const adapter = createAblyInvalidationAdapter({
      realtime: service.realtime,
      namespace: "preview",
    })
    const gapA = vi.fn()
    const first = subscription([axisA], { onSubscriptionGap: gapA })
    const stopFirst = adapter.subscribe(first)
    await adapter.settled()

    const channelA = await ablyAxisChannelName("preview", axisA)
    expect(service.history.slice(0, 3)).toEqual([
      `authorize:${channelA}`,
      `subscribe:${channelA}`,
      `attach:${channelA}`,
    ])
    expect(first.onStatusChange).toHaveBeenLastCalledWith("active")
    expect(gapA).toHaveBeenCalledOnce()

    stopFirst()
    const gapAB = vi.fn()
    const second = subscription([axisA, axisB], { onSubscriptionGap: gapAB })
    const stopSecond = adapter.subscribe(second)
    await adapter.settled()

    const channelB = await ablyAxisChannelName("preview", axisB)
    const exactAuthorization = `authorize:${[channelA, channelB].sort().join(",")}`
    expect(service.history).toContain(exactAuthorization)
    expect(service.history.indexOf(exactAuthorization)).toBeLessThan(
      service.history.indexOf(`attach:${channelB}`)
    )
    expect(second.onStatusChange).toHaveBeenCalledWith("reauthorizing")
    expect(second.onStatusChange).toHaveBeenLastCalledWith("active")
    expect(gapAB).toHaveBeenCalledOnce()

    stopSecond()
    const onlyB = subscription([axisB])
    adapter.subscribe(onlyB)
    await adapter.settled()

    expect(service.history).toContain(`authorize:${channelB}`)
    expect(service.history).toContain(`detach:${channelA}`)
    expect(onlyB.onStatusChange).toHaveBeenLastCalledWith("active")
  })

  it("surfaces authorization and attachment failures as unavailable", async () => {
    const authorizationFailure = new FakeAblyService()
    authorizationFailure.failAuthorization = true
    const authAdapter = createAblyInvalidationAdapter({
      realtime: authorizationFailure.realtime,
      namespace: "preview",
    })
    const authSubscription = subscription([axisA])
    authAdapter.subscribe(authSubscription)
    await authAdapter.settled()

    expect(authSubscription.onStatusChange).toHaveBeenLastCalledWith(
      "unavailable"
    )
    expect(authorizationFailure.history).not.toContainEqual(
      expect.stringMatching(/^attach:/u)
    )

    const attachmentFailure = new FakeAblyService()
    const failedChannel = await ablyAxisChannelName("preview", axisA)
    attachmentFailure.failedAttachments.add(failedChannel)
    const attachAdapter = createAblyInvalidationAdapter({
      realtime: attachmentFailure.realtime,
      namespace: "preview",
    })
    const attachSubscription = subscription([axisA])
    attachAdapter.subscribe(attachSubscription)
    await attachAdapter.settled()

    expect(attachSubscription.onStatusChange).toHaveBeenLastCalledWith(
      "unavailable"
    )
  })

  it("closes every attachment gap after a partial failure recovers", async () => {
    const service = new FakeAblyService()
    const channelA = await ablyAxisChannelName("preview", axisA)
    const channelB = await ablyAxisChannelName("preview", axisB)
    service.failedAttachments.add(channelB)
    const gapA = vi.fn()
    const gapB = vi.fn()
    const observedA = subscription([axisA], { onSubscriptionGap: gapA })
    const observedB = subscription([axisB], { onSubscriptionGap: gapB })
    const adapter = createAblyInvalidationAdapter({
      realtime: service.realtime,
      namespace: "preview",
    })

    adapter.subscribe(observedA)
    adapter.subscribe(observedB)
    await adapter.settled()

    expect(observedA.onStatusChange).toHaveBeenLastCalledWith("unavailable")
    expect(observedB.onStatusChange).toHaveBeenLastCalledWith("unavailable")
    expect(gapA).not.toHaveBeenCalled()
    expect(gapB).not.toHaveBeenCalled()

    service.failedAttachments.delete(channelB)
    adapter.retry()
    await adapter.settled()

    expect(observedA.onStatusChange).toHaveBeenLastCalledWith("active")
    expect(observedB.onStatusChange).toHaveBeenLastCalledWith("active")
    expect(gapA).toHaveBeenCalledOnce()
    expect(gapB).toHaveBeenCalledOnce()
    expect(
      service.history.filter((entry) => entry === `attach:${channelA}`)
    ).toHaveLength(1)
    expect(
      service.history.filter((entry) => entry === `attach:${channelB}`)
    ).toHaveLength(2)
  })

  it("surfaces connection loss and refreshes once after recovery", async () => {
    const service = new FakeAblyService()
    const gap = vi.fn()
    const observed = subscription([axisA], { onSubscriptionGap: gap })
    const adapter = createAblyInvalidationAdapter({
      realtime: service.realtime,
      namespace: "preview",
    })
    adapter.subscribe(observed)
    await adapter.settled()
    gap.mockClear()

    service.disconnect()
    expect(observed.onStatusChange).toHaveBeenLastCalledWith("unavailable")

    service.connect()
    await adapter.settled()
    expect(observed.onStatusChange).toHaveBeenLastCalledWith("active")
    expect(gap).toHaveBeenCalledOnce()
  })

  it("rejects domain-bearing messages and messages for a different axis", async () => {
    const service = new FakeAblyService()
    const malformed = vi.fn()
    const onInvalidation = vi.fn()
    const adapter = createAblyInvalidationAdapter({
      realtime: service.realtime,
      namespace: "preview",
      onMalformedMessage: malformed,
    })
    adapter.subscribe(subscription([axisA], { onInvalidation }))
    await adapter.settled()
    const channelA = await ablyAxisChannelName("preview", axisA)

    service.send(channelA, {
      eventId: "domain-data",
      axis: axisA,
      revision: 1,
      hp: 10,
    })
    service.send(channelA, {
      eventId: "wrong-axis",
      axis: axisB,
      revision: 1,
    })

    expect(onInvalidation).not.toHaveBeenCalled()
    expect(malformed).toHaveBeenCalledTimes(2)
  })

  it("publishes every stamped axis with one event id", async () => {
    const service = new FakeAblyService()
    const publisher = createAblyInvalidationPublisher({
      rest: service.rest,
      namespace: "preview",
    })
    const revisions = revisionVector({ [axisA]: 2, [axisB]: 4 })
    if (!revisions.ok) throw new Error("Invalid Ably publisher test vector")

    await publisher.publish("shared-event", acceptedStamp(revisions.value))

    expect(service.published).toEqual([
      { eventId: "shared-event", axis: axisA, revision: 2 },
      { eventId: "shared-event", axis: axisB, revision: 4 },
    ])
  })
})
