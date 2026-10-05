// @vitest-environment jsdom

import type { Realtime } from "ably"
import { describe, expect, it, vi } from "vitest"

import {
  axisInvalidation,
  type AxisInvalidation,
  type InvalidationStatus,
  type InvalidationSubscription,
} from "../invalidation"
import { axisId, type AxisId } from "../revisions"
import { sha256Hex } from "../sha256"
import {
  verifyInvalidationContract,
  type InvalidationContractHarness,
} from "../testing"
import {
  ABLY_AXIS_INVALIDATION_EVENT,
  ablyAxisChannelName,
  ablyChannelNamespace,
} from "./channels"
import {
  createAblyInvalidationAdapter,
  type AblyChannelState,
  type AblyChannelStateChange,
  type AblyConnectionState,
  type AblyConnectionStateChange,
  type AblyErrorInfo,
  type AblyRealtimeChannel,
  type AblyRealtimeClient,
} from "./client"
import { createAblyInvalidationPublisher, type AblyRestClient } from "./server"

// Hashing resolves in microtasks here, so once the fake service settles, one
// real macrotask drains every pending adapter step. The contract suite installs
// fake timers, so the real `setImmediate` is captured before it does.
vi.mock("../sha256", async () => {
  const { createHash } = await import("node:crypto")
  return {
    sha256Hex: vi.fn(async (input: string | Uint8Array) =>
      createHash("sha256").update(input).digest("hex")
    ),
  }
})
const realSetImmediate = globalThis.setImmediate
const settle = () =>
  new Promise<void>((resolve) => {
    realSetImmediate(resolve)
  })

class FakeChannel implements AblyRealtimeChannel {
  state: AblyChannelState = "initialized"
  readonly messageListeners = new Set<
    (message: { readonly data?: unknown }) => void
  >()
  private readonly stateListeners = new Set<
    (change: AblyChannelStateChange) => void
  >()

  constructor(
    private readonly service: FakeAblyService,
    readonly name: string
  ) {}

  async subscribe(
    event: string,
    listener: (message: { readonly data?: unknown }) => void
  ): Promise<null> {
    this.service.history.push(`subscribe:${this.name}`)
    if (event === ABLY_AXIS_INVALIDATION_EVENT) {
      this.messageListeners.add(listener)
    }
    return null
  }

  unsubscribe(
    _event: string,
    listener: (message: { readonly data?: unknown }) => void
  ): void {
    this.service.history.push(`unsubscribe:${this.name}`)
    this.messageListeners.delete(listener)
  }

  async attach(): Promise<null> {
    this.service.history.push(`attach:${this.name}`)
    if (this.state === "attached") return null
    if (!this.service.authorized.has(this.name)) {
      this.change("failed", { reason: { code: 40160, statusCode: 401 } })
      throw new Error(`unauthorized attach: ${this.name}`)
    }
    if (this.service.failedAttachments.has(this.name)) {
      this.change("failed")
      throw new Error(`attach failed: ${this.name}`)
    }
    this.change("attached")
    return null
  }

  async detach(): Promise<null> {
    this.service.history.push(`detach:${this.name}`)
    this.change("detached")
    return null
  }

  on(listener: (change: AblyChannelStateChange) => void): void {
    this.stateListeners.add(listener)
  }

  off(listener: (change: AblyChannelStateChange) => void): void {
    this.stateListeners.delete(listener)
  }

  change(
    current: AblyChannelState,
    {
      resumed = false,
      reason,
    }: { readonly resumed?: boolean; readonly reason?: AblyErrorInfo } = {}
  ): void {
    this.state = current
    for (const listener of [...this.stateListeners]) {
      listener({ current, resumed, reason })
    }
  }

  deliver(data: unknown): void {
    if (this.state !== "attached") return
    for (const listener of [...this.messageListeners]) listener({ data })
  }
}

class FakeAblyService {
  readonly history: string[] = []
  readonly published: AxisInvalidation[] = []
  readonly failedAttachments = new Set<string>()
  readonly channels = new Map<string, FakeChannel>()
  authorized = new Set<string>()
  authorization: "grant" | "reject" | "stall" = "grant"
  private readonly stalledAuthorizations: (() => void)[] = []
  private readonly connectionListeners = new Set<
    (change: AblyConnectionStateChange) => void
  >()

  private readonly connection = {
    state: "connected" as AblyConnectionState,
    on: (listener: (change: AblyConnectionStateChange) => void) => {
      this.connectionListeners.add(listener)
    },
    off: (listener: (change: AblyConnectionStateChange) => void) => {
      this.connectionListeners.delete(listener)
    },
  }

  readonly realtime: AblyRealtimeClient = {
    auth: {
      authorize: ({ capability }) => {
        const names = Object.keys(capability)
        this.history.push(`authorize:${names.join(",")}`)
        if (this.authorization === "reject") {
          return Promise.reject(new Error("authorization failed"))
        }
        const grant = () => {
          this.authorized = new Set(names)
        }
        if (this.authorization === "stall") {
          return new Promise<void>((resolve) => {
            this.stalledAuthorizations.push(() => {
              grant()
              resolve()
            })
          })
        }
        grant()
        return Promise.resolve()
      },
    },
    channels: {
      get: (name) => this.channel(name),
    },
    connection: this.connection,
  }

  readonly rest: AblyRestClient = {
    batchPublish: async (specs) =>
      specs.map(({ channels, messages }) => ({
        results: channels.map((channel) => {
          for (const { data } of messages) {
            const parsed = axisInvalidation(data)
            if (parsed.ok) this.published.push(parsed.value)
            this.channels.get(channel)?.deliver(data)
          }
          return { channel }
        }),
      })),
  }

  get connectionListenerCount(): number {
    return this.connectionListeners.size
  }

  authorizations(): string[] {
    return this.history.filter((entry) => entry.startsWith("authorize:"))
  }

  releaseStalledAuthorizations(): void {
    for (const release of this.stalledAuthorizations.splice(0)) release()
  }

  setConnection(state: AblyConnectionState, reason?: AblyErrorInfo): void {
    this.connection.state = state
    for (const listener of [...this.connectionListeners]) {
      listener({ current: state, reason })
    }
  }

  channel(name: string): FakeChannel {
    let channel = this.channels.get(name)
    if (!channel) {
      channel = new FakeChannel(this, name)
      this.channels.set(name, channel)
    }
    return channel
  }
}

function ablyContractHarness(): InvalidationContractHarness {
  return {
    name: "Ably",
    create() {
      const service = new FakeAblyService()
      return {
        adapter: createAblyInvalidationAdapter({
          realtime: service.realtime,
          namespace: "contract",
        }),
        publisher: createAblyInvalidationPublisher({
          rest: service.rest,
          namespace: "contract",
        }),
        published: () => service.published,
        settled: settle,
      }
    },
  }
}

verifyInvalidationContract(ablyContractHarness())

const axisA = axisId("entity/a")
const axisB = axisId("entity/b")

function channelFor(axis: AxisId): Promise<string> {
  return ablyAxisChannelName(ablyChannelNamespace("preview"), axis)
}

function subscription(axes: readonly AxisId[]) {
  return {
    axes,
    onInvalidation: vi.fn<(invalidation: AxisInvalidation) => void>(),
    onStatusChange: vi.fn<(status: InvalidationStatus) => void>(),
    onSubscriptionGap: vi.fn<() => void>(),
  } satisfies InvalidationSubscription
}

function adapterFor(service: FakeAblyService) {
  return createAblyInvalidationAdapter({
    realtime: service.realtime,
    namespace: "preview",
  })
}

describe("Ably invalidation capability lifecycle", () => {
  it("accepts the official Ably v2 realtime client", () => {
    const acceptsRealtime = (client: Realtime): AblyRealtimeClient => client

    expect(acceptsRealtime).toBeTypeOf("function")
  })

  it("rejects an invalid namespace at construction", () => {
    const service = new FakeAblyService()

    for (const namespace of ["", " preview", "preview:", "a::b"]) {
      expect(() =>
        createAblyInvalidationAdapter({ realtime: service.realtime, namespace })
      ).toThrow("Invalid Ably axis-channel namespace")
    }
  })

  it("reauthorizes the exact set before attach and closes the attachment gap", async () => {
    const service = new FakeAblyService()
    const adapter = adapterFor(service)
    const first = subscription([axisA])
    const stopFirst = adapter.subscribe(first)
    await settle()

    const channelA = await channelFor(axisA)
    expect(service.history.slice(0, 3)).toEqual([
      `authorize:${channelA}`,
      `subscribe:${channelA}`,
      `attach:${channelA}`,
    ])
    expect(first.onStatusChange).toHaveBeenLastCalledWith("active")
    expect(first.onSubscriptionGap).toHaveBeenCalledOnce()

    stopFirst()
    expect(adapter.initialStatus).toBe("reauthorizing")
    const second = subscription([axisA, axisB])
    const stopSecond = adapter.subscribe(second)
    await settle()

    const channelB = await channelFor(axisB)
    const exactAuthorization = `authorize:${[channelA, channelB].sort().join(",")}`
    expect(service.history).toContain(exactAuthorization)
    expect(service.history.indexOf(exactAuthorization)).toBeLessThan(
      service.history.indexOf(`attach:${channelB}`)
    )
    expect(second.onStatusChange).toHaveBeenLastCalledWith("active")
    expect(second.onSubscriptionGap).toHaveBeenCalledOnce()

    stopSecond()
    const onlyB = subscription([axisB])
    adapter.subscribe(onlyB)
    await settle()

    expect(service.history).toContain(`authorize:${channelB}`)
    expect(service.history).toContain(`detach:${channelA}`)
    expect(onlyB.onStatusChange).toHaveBeenLastCalledWith("active")
  })

  it("surfaces authorization and attachment failures as unavailable", async () => {
    const authorizationFailure = new FakeAblyService()
    authorizationFailure.authorization = "reject"
    const authAdapter = adapterFor(authorizationFailure)
    const authSubscription = subscription([axisA])
    authAdapter.subscribe(authSubscription)
    await settle()

    expect(authSubscription.onStatusChange).toHaveBeenLastCalledWith(
      "unavailable"
    )
    expect(authorizationFailure.history).not.toContainEqual(
      expect.stringMatching(/^attach:/u)
    )

    const attachmentFailure = new FakeAblyService()
    attachmentFailure.failedAttachments.add(await channelFor(axisA))
    const attachAdapter = adapterFor(attachmentFailure)
    const attachSubscription = subscription([axisA])
    attachAdapter.subscribe(attachSubscription)
    await settle()

    expect(attachSubscription.onStatusChange).toHaveBeenLastCalledWith(
      "unavailable"
    )
  })

  it("closes every attachment gap after a partial failure recovers", async () => {
    const service = new FakeAblyService()
    const channelA = await channelFor(axisA)
    const channelB = await channelFor(axisB)
    service.failedAttachments.add(channelB)
    const observedA = subscription([axisA])
    const observedB = subscription([axisB])
    const adapter = adapterFor(service)

    adapter.subscribe(observedA)
    adapter.subscribe(observedB)
    await settle()

    expect(observedA.onStatusChange).toHaveBeenLastCalledWith("unavailable")
    expect(observedB.onStatusChange).toHaveBeenLastCalledWith("unavailable")
    expect(observedA.onSubscriptionGap).not.toHaveBeenCalled()
    expect(observedB.onSubscriptionGap).not.toHaveBeenCalled()

    service.failedAttachments.delete(channelB)
    adapter.retry()
    await settle()

    expect(observedA.onStatusChange).toHaveBeenLastCalledWith("active")
    expect(observedB.onStatusChange).toHaveBeenLastCalledWith("active")
    expect(observedA.onSubscriptionGap).toHaveBeenCalledOnce()
    expect(observedB.onSubscriptionGap).toHaveBeenCalledOnce()
    expect(
      service.history.filter((entry) => entry === `attach:${channelA}`)
    ).toHaveLength(1)
    expect(
      service.history.filter((entry) => entry === `attach:${channelB}`)
    ).toHaveLength(2)
  })

  it("surfaces connection loss and refreshes once after recovery without a new token", async () => {
    const service = new FakeAblyService()
    const observed = subscription([axisA])
    const adapter = adapterFor(service)
    adapter.subscribe(observed)
    await settle()
    observed.onSubscriptionGap.mockClear()
    const authorizations = service.authorizations().length

    service.setConnection("disconnected")
    expect(observed.onStatusChange).toHaveBeenLastCalledWith("unavailable")
    service.setConnection("connecting")
    expect(observed.onStatusChange).toHaveBeenLastCalledWith("unavailable")

    service.setConnection("connected")
    await settle()
    expect(observed.onStatusChange).toHaveBeenLastCalledWith("active")
    expect(observed.onSubscriptionGap).toHaveBeenCalledOnce()
    expect(service.authorizations()).toHaveLength(authorizations)
  })

  it("reports unavailable, not reauthorizing, when subscribing during an outage", async () => {
    const service = new FakeAblyService()
    service.setConnection("disconnected")
    const adapter = adapterFor(service)
    const observed = subscription([axisA])

    expect(adapter.initialStatus).toBe("unavailable")
    adapter.subscribe(observed)
    await settle()

    expect(observed.onStatusChange).not.toHaveBeenCalledWith("reauthorizing")
    expect(adapter.initialStatus).toBe("unavailable")

    service.setConnection("connected")
    await settle()
    expect(observed.onStatusChange).toHaveBeenLastCalledWith("active")
    expect(observed.onSubscriptionGap).toHaveBeenCalledOnce()
  })

  it("reports a failed channel while connected and re-attaches it on retry", async () => {
    const service = new FakeAblyService()
    const adapter = adapterFor(service)
    const observed = subscription([axisA])
    adapter.subscribe(observed)
    await settle()
    const channelA = service.channel(await channelFor(axisA))
    observed.onSubscriptionGap.mockClear()

    channelA.change("failed")
    expect(observed.onStatusChange).toHaveBeenLastCalledWith("unavailable")
    expect(adapter.initialStatus).toBe("unavailable")

    adapter.retry()
    await settle()
    expect(channelA.state).toBe("attached")
    expect(
      service.history.filter((entry) => entry === `attach:${channelA.name}`)
    ).toHaveLength(2)
    expect(observed.onStatusChange).toHaveBeenLastCalledWith("active")
    expect(observed.onSubscriptionGap).toHaveBeenCalledOnce()
  })

  it("reauthorizes on retry only after Ably reports an auth error", async () => {
    const service = new FakeAblyService()
    const adapter = adapterFor(service)
    adapter.subscribe(subscription([axisA]))
    await settle()
    const channelA = service.channel(await channelFor(axisA))

    channelA.change("failed")
    adapter.retry()
    await settle()
    expect(service.authorizations()).toHaveLength(1)

    channelA.change("failed", { reason: { code: 40160, statusCode: 401 } })
    adapter.retry()
    await settle()
    expect(service.authorizations()).toHaveLength(2)
    expect(channelA.state).toBe("attached")
  })

  it("requests a refresh when channel continuity is lost while connected", async () => {
    const service = new FakeAblyService()
    const adapter = adapterFor(service)
    const observedA = subscription([axisA])
    const observedB = subscription([axisB])
    adapter.subscribe(observedA)
    adapter.subscribe(observedB)
    await settle()
    const channelA = service.channel(await channelFor(axisA))
    observedA.onSubscriptionGap.mockClear()
    observedB.onSubscriptionGap.mockClear()

    channelA.change("attached", { resumed: true })
    expect(observedA.onSubscriptionGap).not.toHaveBeenCalled()

    channelA.change("attached", { resumed: false })
    expect(observedA.onSubscriptionGap).toHaveBeenCalledOnce()
    expect(observedA.onStatusChange).toHaveBeenLastCalledWith("active")

    channelA.change("suspended")
    expect(observedA.onStatusChange).toHaveBeenLastCalledWith("unavailable")
    channelA.change("attaching")
    expect(observedA.onStatusChange).toHaveBeenLastCalledWith("reauthorizing")
    channelA.change("attached", { resumed: false })
    expect(observedA.onStatusChange).toHaveBeenLastCalledWith("active")
    expect(observedA.onSubscriptionGap).toHaveBeenCalledTimes(2)
    expect(observedB.onSubscriptionGap).not.toHaveBeenCalled()
  })

  it("gives each new subscription its own gap on an already attached channel", async () => {
    const service = new FakeAblyService()
    const adapter = adapterFor(service)
    const first = subscription([axisA])
    const second = subscription([axisA])
    adapter.subscribe(first)
    await settle()

    expect(adapter.initialStatus).toBe("active")
    adapter.subscribe(second)
    await settle()

    expect(first.onSubscriptionGap).toHaveBeenCalledOnce()
    expect(second.onSubscriptionGap).toHaveBeenCalledOnce()
    expect(second.onStatusChange).not.toHaveBeenCalled()
    expect(service.authorizations()).toHaveLength(1)
  })

  it("releases channels without authorizing when the last subscription leaves", async () => {
    for (const authorization of ["reject", "stall"] as const) {
      const service = new FakeAblyService()
      const adapter = adapterFor(service)
      const observedA = subscription([axisA])
      const stopA = adapter.subscribe(observedA)
      await settle()
      const channelA = service.channel(await channelFor(axisA))

      service.authorization = authorization
      const stopAB = adapter.subscribe(subscription([axisA, axisB]))
      await settle()
      const authorizations = service.authorizations().length

      stopAB()
      stopA()
      await settle()

      expect(channelA.messageListeners.size).toBe(0)
      expect(service.history).toContain(`detach:${channelA.name}`)
      expect(service.authorizations()).toHaveLength(authorizations)
      expect(service.connectionListenerCount).toBe(0)
      expect(adapter.initialStatus).toBe("reauthorizing")

      service.releaseStalledAuthorizations()
      await settle()
      expect(service.history).not.toContain(`attach:${await channelFor(axisB)}`)
    }
  })

  it("hashes each axis once across reconciliations", async () => {
    const service = new FakeAblyService()
    const adapter = adapterFor(service)
    vi.mocked(sha256Hex).mockClear()

    adapter.subscribe(subscription([axisA]))
    await settle()
    adapter.subscribe(subscription([axisA, axisB]))
    await settle()
    adapter.retry()
    await settle()

    expect(vi.mocked(sha256Hex).mock.calls).toEqual([[axisA], [axisB]])
  })

  it("rejects domain-bearing messages and messages for a different axis", async () => {
    const service = new FakeAblyService()
    const malformed = vi.fn()
    const adapter = createAblyInvalidationAdapter({
      realtime: service.realtime,
      namespace: "preview",
      onMalformedMessage: malformed,
    })
    const observed = subscription([axisA])
    adapter.subscribe(observed)
    await settle()
    const channelA = service.channel(await channelFor(axisA))

    channelA.deliver({
      eventId: "domain-data",
      axis: axisA,
      revision: 1,
      hp: 10,
    })
    channelA.deliver({ eventId: "wrong-axis", axis: axisB, revision: 1 })

    expect(observed.onInvalidation).not.toHaveBeenCalled()
    expect(malformed.mock.calls).toEqual([
      [expect.objectContaining({ reason: "unexpected-field" })],
      [
        {
          code: "axis-channel-mismatch",
          expectedAxis: axisA,
          value: { eventId: "wrong-axis", axis: axisB, revision: 1 },
        },
      ],
    ])
  })
})
