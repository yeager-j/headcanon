// @vitest-environment jsdom

import type { Realtime } from "ably"
import type { BaseRealtime } from "ably/modular"
import { describe, expect, expectTypeOf, it, vi } from "vitest"

import {
  axisInvalidation,
  type AxisInvalidation,
  type InvalidationStatus,
  type InvalidationSubscription,
} from "../core/invalidation"
import { axisId, type AxisId } from "../core/revisions"
import { sha256Hex } from "../core/sha256"
import {
  verifyInvalidationContract,
  type InvalidationContractHarness,
} from "../testing/contracts"
import {
  ABLY_AXIS_INVALIDATION_EVENT,
  ablyAxisChannelName,
  ablyChannelNamespace,
  ablySubscribeCapability,
} from "./channels"
import {
  createAblyAxisInvalidations,
  createAblyInvalidationAdapter,
  type AblyAxisInvalidationsOptions,
  type AblyChannelState,
  type AblyChannelStateChange,
  type AblyConnectionState,
  type AblyConnectionStateChange,
  type AblyErrorInfo,
  type AblyRealtimeChannel,
  type AblyRealtimeClient,
  type AblyRealtimeOptions,
  type AblyTokenRequest,
} from "./client"
import { createAblyInvalidationPublisher, type AblyRestClient } from "./server"

// Hashing resolves in microtasks here, so once the fake service settles, one
// real macrotask drains every pending adapter step. The contract suite installs
// fake timers, so the real `setImmediate` is captured before it does.
vi.mock("../core/sha256", async () => {
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
  authorizationMode: "grant" | "reject" | "stall" = "grant"
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
        if (this.authorizationMode === "reject") {
          return Promise.reject(new Error("authorization failed"))
        }
        const grant = () => {
          this.authorized = new Set(names)
        }
        if (this.authorizationMode === "stall") {
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
const namespace = ablyChannelNamespace("preview")

function channelFor(axis: AxisId): Promise<string> {
  return ablyAxisChannelName(namespace, axis)
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
    namespace,
  })
}

describe("Ably invalidation capability lifecycle", () => {
  it("accepts the official Ably v2 realtime client", () => {
    expectTypeOf<Realtime>().toExtend<AblyRealtimeClient>()
  })

  it("rejects an invalid namespace at construction", () => {
    const service = new FakeAblyService()

    for (const invalidNamespace of ["", " preview", "preview:", "a::b"]) {
      expect(() =>
        createAblyInvalidationAdapter({
          realtime: service.realtime,
          namespace: invalidNamespace,
        })
      ).toThrow("Invalid Ably axis-channel namespace")
    }
  })

  it("reauthorizes the exact set before attach and closes the attachment gap", async () => {
    const service = new FakeAblyService()
    const adapter = adapterFor(service)
    const first = subscription([axisA])
    const stopFirst = adapter.subscribe(first)
    await settle()

    const channelNameA = await channelFor(axisA)
    expect(service.history.slice(0, 3)).toEqual([
      `authorize:${channelNameA}`,
      `subscribe:${channelNameA}`,
      `attach:${channelNameA}`,
    ])
    expect(first.onStatusChange).toHaveBeenLastCalledWith("active")
    expect(first.onSubscriptionGap).toHaveBeenCalledOnce()

    stopFirst()
    expect(adapter.initialStatus).toBe("reauthorizing")
    const second = subscription([axisA, axisB])
    const stopSecond = adapter.subscribe(second)
    await settle()

    const channelNameB = await channelFor(axisB)
    const exactAuthorization = `authorize:${[channelNameA, channelNameB].sort().join(",")}`
    expect(service.history).toContain(exactAuthorization)
    expect(service.history.indexOf(exactAuthorization)).toBeLessThan(
      service.history.indexOf(`attach:${channelNameB}`)
    )
    expect(second.onStatusChange).toHaveBeenLastCalledWith("active")
    expect(second.onSubscriptionGap).toHaveBeenCalledOnce()

    stopSecond()
    const onlyB = subscription([axisB])
    adapter.subscribe(onlyB)
    await settle()

    expect(service.history).toContain(`authorize:${channelNameB}`)
    expect(service.history).toContain(`detach:${channelNameA}`)
    expect(onlyB.onStatusChange).toHaveBeenLastCalledWith("active")
  })

  it("surfaces authorization and attachment failures as unavailable", async () => {
    const rejectingService = new FakeAblyService()
    rejectingService.authorizationMode = "reject"
    const authAdapter = adapterFor(rejectingService)
    const authSubscription = subscription([axisA])
    authAdapter.subscribe(authSubscription)
    await settle()

    expect(authSubscription.onStatusChange).toHaveBeenLastCalledWith(
      "unavailable"
    )
    expect(rejectingService.history).not.toContainEqual(
      expect.stringMatching(/^attach:/u)
    )

    const failingAttachService = new FakeAblyService()
    failingAttachService.failedAttachments.add(await channelFor(axisA))
    const attachAdapter = adapterFor(failingAttachService)
    const attachSubscription = subscription([axisA])
    attachAdapter.subscribe(attachSubscription)
    await settle()

    expect(attachSubscription.onStatusChange).toHaveBeenLastCalledWith(
      "unavailable"
    )
  })

  it("closes every attachment gap after a partial failure recovers", async () => {
    const service = new FakeAblyService()
    const channelNameA = await channelFor(axisA)
    const channelNameB = await channelFor(axisB)
    service.failedAttachments.add(channelNameB)
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

    service.failedAttachments.delete(channelNameB)
    adapter.retry()
    await settle()

    expect(observedA.onStatusChange).toHaveBeenLastCalledWith("active")
    expect(observedB.onStatusChange).toHaveBeenLastCalledWith("active")
    expect(observedA.onSubscriptionGap).toHaveBeenCalledOnce()
    expect(observedB.onSubscriptionGap).toHaveBeenCalledOnce()
    expect(
      service.history.filter((entry) => entry === `attach:${channelNameA}`)
    ).toHaveLength(1)
    expect(
      service.history.filter((entry) => entry === `attach:${channelNameB}`)
    ).toHaveLength(2)
  })

  it("surfaces connection loss and refreshes once after recovery without a new token", async () => {
    const service = new FakeAblyService()
    const observed = subscription([axisA])
    const adapter = adapterFor(service)
    adapter.subscribe(observed)
    await settle()
    observed.onSubscriptionGap.mockClear()
    const authorizationCount = service.authorizations().length

    service.setConnection("disconnected")
    expect(observed.onStatusChange).toHaveBeenLastCalledWith("unavailable")
    service.setConnection("connecting")
    expect(observed.onStatusChange).toHaveBeenLastCalledWith("unavailable")

    service.setConnection("connected")
    await settle()
    expect(observed.onStatusChange).toHaveBeenLastCalledWith("active")
    expect(observed.onSubscriptionGap).toHaveBeenCalledOnce()
    expect(service.authorizations()).toHaveLength(authorizationCount)
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
    for (const mode of ["reject", "stall"] as const) {
      const service = new FakeAblyService()
      const adapter = adapterFor(service)
      const observedA = subscription([axisA])
      const stopA = adapter.subscribe(observedA)
      await settle()
      const channelA = service.channel(await channelFor(axisA))

      service.authorizationMode = mode
      const stopAB = adapter.subscribe(subscription([axisA, axisB]))
      await settle()
      const authorizationCount = service.authorizations().length

      stopAB()
      stopA()
      await settle()

      expect(channelA.messageListeners.size).toBe(0)
      expect(service.history).toContain(`detach:${channelA.name}`)
      expect(service.authorizations()).toHaveLength(authorizationCount)
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
    const onMalformedMessage = vi.fn()
    const adapter = createAblyInvalidationAdapter({
      realtime: service.realtime,
      namespace,
      onMalformedMessage,
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
    expect(onMalformedMessage.mock.calls).toEqual([
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

/** A signed-looking token request granting `subscribe` on `channels`. */
function tokenRequestFor(channels: readonly string[]): AblyTokenRequest {
  return {
    keyName: "app.key",
    timestamp: 0,
    nonce: "nonce",
    mac: "mac",
    capability: JSON.stringify(ablySubscribeCapability(channels)),
  }
}

/**
 * A `createRealtime` over the fake service whose `authorize()` goes through
 * the given `authCallback`, as the Ably SDK's does, and grants the returned
 * token's capability.
 */
function realtimeFactory(service: FakeAblyService) {
  const created: AblyRealtimeOptions[] = []
  const createRealtime = vi.fn(
    (options: AblyRealtimeOptions): AblyRealtimeClient => {
      created.push(options)
      return {
        ...service.realtime,
        auth: {
          authorize: (tokenParams) =>
            new Promise((resolve, reject) => {
              options.authCallback(tokenParams, (error, tokenRequest) => {
                if (error !== null || tokenRequest === null) {
                  reject(new Error(error ?? "no token request"))
                  return
                }
                resolve(
                  service.realtime.auth.authorize({
                    capability: JSON.parse(tokenRequest.capability),
                  })
                )
              })
            }),
        },
      }
    }
  )
  return { createRealtime, created }
}

/** A token endpoint that approves every requested axis. */
function approvingTokenEndpoint() {
  return vi.fn(async (axes: readonly AxisId[]) =>
    tokenRequestFor(await Promise.all(axes.map(channelFor)))
  )
}

describe("createAblyAxisInvalidations", () => {
  it("accepts the official Ably v2 clients through createRealtime", () => {
    expectTypeOf<BaseRealtime>().toExtend<AblyRealtimeClient>()

    // Compiles only while Headcanon's options fit both SDK constructors.
    const fromRealtime =
      (SDK: typeof Realtime): AblyAxisInvalidationsOptions["createRealtime"] =>
      (options) =>
        new SDK(options)
    const fromModular =
      (
        SDK: typeof BaseRealtime
      ): AblyAxisInvalidationsOptions["createRealtime"] =>
      (options) =>
        new SDK({ ...options, plugins: {} })
    expect([fromRealtime, fromModular]).toHaveLength(2)
  })

  it("authorizes axes, not channel names, with a client that waits for that authorization", async () => {
    const service = new FakeAblyService()
    const { createRealtime, created } = realtimeFactory(service)
    const requestToken = approvingTokenEndpoint()
    const adapter = createAblyAxisInvalidations({
      namespace,
      createRealtime,
      requestToken,
    })
    const observer = subscription([axisB, axisA])

    expect(createRealtime).not.toHaveBeenCalled()
    adapter.subscribe(observer)
    await settle()

    expect(created).toEqual([
      { autoConnect: false, authCallback: expect.any(Function) },
    ])
    expect(requestToken).toHaveBeenCalledExactlyOnceWith([axisA, axisB])
    expect(service.authorizations()).toEqual([
      `authorize:${(await Promise.all([axisA, axisB].map(channelFor))).sort().join(",")}`,
    ])
    expect(observer.onStatusChange).toHaveBeenLastCalledWith("active")
    expect(observer.onSubscriptionGap).toHaveBeenCalledOnce()
  })

  it("renews from a serialized capability and drops channels it does not observe", async () => {
    const service = new FakeAblyService()
    const { createRealtime, created } = realtimeFactory(service)
    const requestToken = approvingTokenEndpoint()
    const adapter = createAblyAxisInvalidations({
      namespace,
      createRealtime,
      requestToken,
    })
    adapter.subscribe(subscription([axisA]))
    await settle()
    const authCallback = created[0]?.authCallback
    if (!authCallback) throw new Error("createRealtime was not called")
    const unobserved = await channelFor(axisB)
    const renewal = vi.fn()

    authCallback(
      {
        capability: JSON.stringify(
          ablySubscribeCapability([await channelFor(axisA), unobserved])
        ),
      },
      renewal
    )
    await settle()
    authCallback({ capability: { [unobserved]: ["subscribe"] } }, renewal)

    expect(requestToken).toHaveBeenLastCalledWith([axisA])
    expect(requestToken).toHaveBeenCalledTimes(2)
    expect(renewal).toHaveBeenNthCalledWith(
      1,
      null,
      tokenRequestFor([await channelFor(axisA)])
    )
    expect(renewal).toHaveBeenNthCalledWith(
      2,
      "No observed axes to authorize",
      null
    )
  })

  it("stays unavailable without a client while the namespace is missing, then starts on retry", async () => {
    const service = new FakeAblyService()
    const { createRealtime } = realtimeFactory(service)
    const loadNamespace = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("preview")
    const adapter = createAblyAxisInvalidations({
      namespace: loadNamespace,
      createRealtime,
      requestToken: approvingTokenEndpoint(),
    })
    const observer = subscription([axisA])

    adapter.subscribe(observer)
    await settle()
    expect(observer.onStatusChange).toHaveBeenLastCalledWith("unavailable")
    expect(createRealtime).not.toHaveBeenCalled()

    adapter.retry()
    await settle()

    expect(loadNamespace).toHaveBeenCalledTimes(2)
    expect(createRealtime).toHaveBeenCalledOnce()
    expect(
      observer.onStatusChange.mock.calls.map(([status]) => status)
    ).toEqual(["unavailable", "reauthorizing", "active"])
  })

  it("reports an invalid loaded namespace before creating a client", async () => {
    const service = new FakeAblyService()
    const { createRealtime } = realtimeFactory(service)
    const onInitializationError = vi.fn()
    const adapter = createAblyAxisInvalidations({
      namespace: async () => "preview:",
      createRealtime,
      requestToken: approvingTokenEndpoint(),
      onInitializationError,
    })
    const observer = subscription([axisA])

    adapter.subscribe(observer)
    await settle()

    expect(onInitializationError).toHaveBeenCalledOnce()
    expect(createRealtime).not.toHaveBeenCalled()
    expect(observer.onStatusChange).toHaveBeenLastCalledWith("unavailable")
  })

  it("rejects an invalid string namespace at construction", () => {
    const service = new FakeAblyService()

    expect(() =>
      createAblyAxisInvalidations({
        namespace: "preview:",
        createRealtime: realtimeFactory(service).createRealtime,
        requestToken: approvingTokenEndpoint(),
      })
    ).toThrow("Invalid Ably axis-channel namespace")
  })

  it("gives a client abandoned by a failed start no axes to authorize", async () => {
    const service = new FakeAblyService()
    service.setConnection("disconnected")
    const { createRealtime, created } = realtimeFactory(service)
    const requestToken = approvingTokenEndpoint()
    const adapter = createAblyAxisInvalidations({
      namespace,
      createRealtime,
      requestToken,
      onInitializationError: () => undefined,
    })
    const steady = subscription([axisA])
    const fragile = subscription([axisA])
    fragile.onStatusChange.mockImplementationOnce(() => {
      throw new Error("status callback failed")
    })

    adapter.subscribe(steady)
    adapter.subscribe(fragile)
    await settle()
    service.setConnection("connected")
    adapter.retry()
    await settle()

    expect(createRealtime).toHaveBeenCalledTimes(2)
    expect(steady.onStatusChange).toHaveBeenLastCalledWith("active")
    expect(fragile.onStatusChange).toHaveBeenLastCalledWith("active")

    const abandoned = created[0]?.authCallback
    if (!abandoned) throw new Error("createRealtime was not called")
    const renewal = vi.fn()
    abandoned(
      { capability: ablySubscribeCapability([await channelFor(axisA)]) },
      renewal
    )

    expect(renewal).toHaveBeenCalledExactlyOnceWith(
      "No observed axes to authorize",
      null
    )
    expect(requestToken).toHaveBeenCalledOnce()
  })

  it("reports a refused token as unavailable and reauthorizes on retry", async () => {
    const service = new FakeAblyService()
    const { createRealtime } = realtimeFactory(service)
    const approve = approvingTokenEndpoint()
    const requestToken = vi
      .fn<(axes: readonly AxisId[]) => Promise<AblyTokenRequest>>()
      .mockRejectedValueOnce(new Error("Forbidden"))
      .mockImplementation(approve)
    const onLifecycleError = vi.fn()
    const adapter = createAblyAxisInvalidations({
      namespace,
      createRealtime,
      requestToken,
      onLifecycleError,
    })
    const observer = subscription([axisA])

    adapter.subscribe(observer)
    await settle()
    expect(observer.onStatusChange).toHaveBeenLastCalledWith("unavailable")
    expect(onLifecycleError).toHaveBeenCalledWith(new Error("Forbidden"))

    adapter.retry()
    await settle()

    expect(requestToken).toHaveBeenCalledTimes(2)
    expect(observer.onStatusChange).toHaveBeenLastCalledWith("active")
    expect(createRealtime).toHaveBeenCalledOnce()
  })
})
