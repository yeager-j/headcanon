import {
  axisInvalidation,
  createRestartableLazyAdapter,
  type AxisInvalidationValidationError,
  type InvalidationStatus,
  type InvalidationSubscription,
  type RetryableInvalidationAdapter,
} from "../core/invalidation"
import type { AxisId } from "../core/revisions"
import {
  ABLY_AXIS_INVALIDATION_EVENT,
  ablyAxisChannelName,
  ablyChannelNamespace,
  ablySubscribeCapability,
  type AblyChannelNamespace,
} from "./channels"
import type { AblyTokenRequest } from "./token-request"

export type { AblyTokenRequest } from "./token-request"

interface AblyMessage {
  readonly data?: unknown
}

type AblyMessageListener = (message: AblyMessage) => void

/** The parts of an Ably `ErrorInfo` the adapter reads to recognize auth errors. */
export interface AblyErrorInfo {
  readonly code?: number
  readonly statusCode?: number
}

/** Ably channel states, as reported by `RealtimeChannel.state`. */
export type AblyChannelState =
  | "initialized"
  | "attaching"
  | "attached"
  | "detaching"
  | "detached"
  | "suspended"
  | "failed"

/**
 * One channel state change. `current: "attached"` with `resumed: false`
 * (an `attached` or `update` event) means message continuity was lost.
 */
export interface AblyChannelStateChange {
  readonly current: AblyChannelState
  readonly resumed: boolean
  readonly reason?: AblyErrorInfo
}

type AblyChannelStateListener = (change: AblyChannelStateChange) => void

/** Minimal channel contract required by the client invalidation adapter. */
export interface AblyRealtimeChannel {
  readonly state: AblyChannelState
  subscribe(name: string, listener: AblyMessageListener): Promise<unknown>
  unsubscribe(name: string, listener: AblyMessageListener): void
  attach(): Promise<unknown>
  detach(): Promise<unknown>
  /** Listens to every channel event, including `update`. */
  on(listener: AblyChannelStateListener): void
  off(listener: AblyChannelStateListener): void
}

/** Ably connection states, as reported by `Connection.state`. */
export type AblyConnectionState =
  | "initialized"
  | "connecting"
  | "connected"
  | "disconnected"
  | "suspended"
  | "closing"
  | "closed"
  | "failed"

/** One connection state change. */
export interface AblyConnectionStateChange {
  readonly current: AblyConnectionState
  readonly reason?: AblyErrorInfo
}

type AblyConnectionListener = (change: AblyConnectionStateChange) => void

/** Connection state and lifecycle events used to derive adapter status. */
export interface AblyRealtimeConnection {
  readonly state: AblyConnectionState
  /** Listens to every connection event, including `update`. */
  on(listener: AblyConnectionListener): void
  off(listener: AblyConnectionListener): void
}

/** Minimal Ably realtime client contract required for exact-set authorization. */
export interface AblyRealtimeClient {
  readonly auth: {
    /** Requests a token whose capability is exactly `capability`, replacing the current token. */
    authorize(tokenParams: {
      readonly capability: Record<string, ["subscribe"]>
    }): Promise<unknown>
  }
  readonly channels: {
    get(
      name: string,
      options: { readonly attachOnSubscribe: false }
    ): AblyRealtimeChannel
  }
  readonly connection: AblyRealtimeConnection
}

/**
 * Why the adapter dropped an inbound message: the payload failed parsing, or
 * it parsed but names a different axis than the channel it arrived on.
 */
export type AblyInvalidationMessageError =
  | AxisInvalidationValidationError
  | {
      readonly code: "axis-channel-mismatch"
      readonly expectedAxis: AxisId
      readonly value: unknown
    }

/** Ably invalidation adapter with an explicit retry control. */
export interface AblyInvalidationAdapter extends RetryableInvalidationAdapter {
  /**
   * Retries after `unavailable`: reauthorizes when the axis set changed, the
   * last authorization failed, or Ably reported an auth error, then re-attaches
   * every observed channel that is not attached.
   */
  retry(): void
}

interface SubscriptionEntry {
  readonly subscription: InvalidationSubscription
  /** Last status this subscription was told (or started in). */
  reported: InvalidationStatus
  /** Whether this subscription still needs an `onSubscriptionGap` call. */
  awaitingGap: boolean
}

interface AxisChannel {
  readonly channel: AblyRealtimeChannel
  readonly onMessage: AblyMessageListener
  readonly onStateChange: AblyChannelStateListener
}

const UNAVAILABLE_CONNECTION_STATES: ReadonlySet<AblyConnectionState> = new Set(
  ["disconnected", "suspended", "closing", "closed", "failed"]
)

function isAuthError(reason: AblyErrorInfo | undefined): boolean {
  if (!reason) return false
  const { code, statusCode } = reason
  return (
    statusCode === 401 || (code !== undefined && code >= 40100 && code < 40200)
  )
}

function sameMembers(
  left: ReadonlySet<string>,
  right: readonly string[]
): boolean {
  return left.size === right.length && right.every((name) => left.has(name))
}

/**
 * Owns exact-set authorization, attachment, and gap recovery for mounted roots.
 *
 * The adapter aggregates axes from all live subscriptions, authorizes exactly
 * that deduplicated channel set, and attaches channels only after
 * authorization succeeds. It requests a new token only when that set changes
 * or Ably reports an auth error; connection recovery reuses the token. An
 * empty set requests nothing.
 *
 * Status is `unavailable` while the connection is down, a desired channel is
 * `failed` or `suspended`, or the last reconciliation failed for a channel
 * that is still not attached; otherwise `reauthorizing`
 * until every desired channel is attached, then `active`. With no
 * subscriptions the status is `reauthorizing` (or `unavailable` while the
 * connection is down), never `active`.
 *
 * Each new subscription receives one `onSubscriptionGap` once its axes are
 * delivering, including when it joins channels that are already attached.
 * Connection recovery and channel continuity loss (`attached` or `update`
 * with `resumed: false`) request the gap again for affected subscriptions;
 * the two can produce two refreshes for one outage.
 *
 * Unsubscribing detaches, in a microtask, the channels no remaining
 * subscription observes, without waiting for a pending authorization.
 * Malformed payloads and lifecycle failures go to the optional diagnostics
 * callbacks and do not affect subscriptions.
 *
 * @param options Realtime client, deployment namespace, and diagnostics.
 * @returns An Ably invalidation adapter with a `retry()` control.
 * @throws Error at construction when `namespace` is invalid (see `ablyChannelNamespace`).
 */
export function createAblyInvalidationAdapter(
  options: AblyAdapterOptions
): AblyInvalidationAdapter {
  return createAblyAdapterCore(options).adapter
}

interface AblyAdapterOptions {
  readonly realtime: AblyRealtimeClient
  readonly namespace: string
  readonly onMalformedMessage?: (error: AblyInvalidationMessageError) => void
  readonly onLifecycleError?: (error: unknown) => void
}

/** The adapter, plus the lookup `createAblyAxisInvalidations` authorizes with. */
interface AblyAdapterCore {
  readonly adapter: AblyInvalidationAdapter
  /**
   * The observed axes whose channels are among `names`. A name that is not an
   * observed axis's channel is dropped, so a token built from the result is
   * never wider than what the adapter observes.
   */
  axesForChannels(names: ReadonlySet<string>): AxisId[]
}

function createAblyAdapterCore(options: AblyAdapterOptions): AblyAdapterCore {
  const namespace = ablyChannelNamespace(options.namespace)
  const { realtime } = options
  const entries = new Set<SubscriptionEntry>()
  const channels = new Map<AxisId, AxisChannel>()
  const channelNames = new Map<AxisId, Promise<string>>()
  /** Each name in `channelNames` once it resolves, for the synchronous lookup. */
  const resolvedNames = new Map<AxisId, string>()
  let authorizedNames: ReadonlySet<string> | null = null
  let reconcileFailed = false
  let connectionLost = false
  let monitoring = false
  let releaseScheduled = false
  let requestedGeneration = 0
  let completedGeneration = 0
  let reconciling = false

  const reportLifecycleError = (error: unknown) => {
    try {
      options.onLifecycleError?.(error)
    } catch {
      // Diagnostics must not take ownership of the subscription lifecycle.
    }
  }

  const reportMalformedMessage = (error: AblyInvalidationMessageError) => {
    try {
      options.onMalformedMessage?.(error)
    } catch {
      // An observer cannot turn rejected input into a channel-listener failure.
    }
  }

  const observedAxes = (): readonly AxisId[] =>
    [
      ...new Set([...entries].flatMap(({ subscription }) => subscription.axes)),
    ].sort()

  const channelName = (axis: AxisId): Promise<string> => {
    let name = channelNames.get(axis)
    if (!name) {
      name = ablyAxisChannelName(namespace, axis).then((resolved) => {
        resolvedNames.set(axis, resolved)
        return resolved
      })
      channelNames.set(axis, name)
    }
    return name
  }

  const deriveStatus = (): InvalidationStatus => {
    if (
      UNAVAILABLE_CONNECTION_STATES.has(realtime.connection.state) ||
      (monitoring && connectionLost)
    ) {
      return "unavailable"
    }
    if (entries.size === 0) return "reauthorizing"

    let allAttached = true
    for (const axis of observedAxes()) {
      const state = channels.get(axis)?.channel.state
      if (state === "failed" || state === "suspended") return "unavailable"
      if (state !== "attached") allAttached = false
    }
    if (allAttached) return "active"
    return reconcileFailed ? "unavailable" : "reauthorizing"
  }

  /** Tells each subscription the derived status if it differs from what it was last told. */
  const reportStatus = () => {
    const status = deriveStatus()
    for (const entry of [...entries]) {
      if (!entries.has(entry) || entry.reported === status) continue
      entry.reported = status
      entry.subscription.onStatusChange(status)
    }
  }

  /** Delivers pending gap requests once delivery is active. */
  const closeGaps = () => {
    if (deriveStatus() !== "active") return
    for (const entry of [...entries]) {
      if (!entries.has(entry) || !entry.awaitingGap) continue
      entry.awaitingGap = false
      entry.subscription.onSubscriptionGap?.()
    }
  }

  const requestGap = (axis: AxisId | null) => {
    for (const entry of entries) {
      if (axis === null || entry.subscription.axes.includes(axis)) {
        entry.awaitingGap = true
      }
    }
  }

  const releaseUnobservedChannels = () => {
    releaseScheduled = false
    const observed = new Set(observedAxes())
    for (const [axis, axisChannel] of channels) {
      if (observed.has(axis)) continue
      channels.delete(axis)
      channelNames.delete(axis)
      resolvedNames.delete(axis)
      const { channel, onMessage, onStateChange } = axisChannel
      channel.unsubscribe(ABLY_AXIS_INVALIDATION_EVENT, onMessage)
      channel.off(onStateChange)
      channel.detach().catch(reportLifecycleError)
    }
  }

  const openChannel = (axis: AxisId, name: string): AxisChannel => {
    const channel = realtime.channels.get(name, { attachOnSubscribe: false })
    const onMessage: AblyMessageListener = (message) => {
      const parsed = axisInvalidation(message.data)
      if (!parsed.ok) {
        reportMalformedMessage(parsed.error)
        return
      }
      if (parsed.value.axis !== axis) {
        reportMalformedMessage({
          code: "axis-channel-mismatch",
          expectedAxis: axis,
          value: message.data,
        })
        return
      }
      for (const { subscription } of [...entries]) {
        if (subscription.axes.includes(axis)) {
          subscription.onInvalidation(parsed.value)
        }
      }
    }
    const axisChannel: AxisChannel = {
      channel,
      onMessage,
      onStateChange: (change) => {
        if (channels.get(axis) !== axisChannel) return
        if (isAuthError(change.reason)) authorizedNames = null
        if (change.current === "attached" && !change.resumed) requestGap(axis)
        reportStatus()
        closeGaps()
      },
    }
    channel.on(axisChannel.onStateChange)
    channels.set(axis, axisChannel)
    return axisChannel
  }

  const ensureAttached = async (axis: AxisId, name: string): Promise<void> => {
    const existing = channels.get(axis)
    if (existing?.channel.state === "attached") return

    // Whatever this attachment misses is closed by a refresh once it is live.
    requestGap(axis)
    const axisChannel = existing ?? openChannel(axis, name)
    if (!existing) {
      await axisChannel.channel.subscribe(
        ABLY_AXIS_INVALIDATION_EVENT,
        axisChannel.onMessage
      )
    }
    if (channels.get(axis) !== axisChannel) return
    await axisChannel.channel.attach()
  }

  const reconcileOnce = async (generation: number): Promise<void> => {
    const axes = observedAxes()
    if (axes.length === 0) return

    const names = await Promise.all(axes.map(channelName))
    if (generation !== requestedGeneration) return

    if (authorizedNames === null || !sameMembers(authorizedNames, names)) {
      try {
        await realtime.auth.authorize({
          capability: ablySubscribeCapability(names),
        })
      } catch (error) {
        authorizedNames = null
        throw error
      }
      authorizedNames = new Set(names)
      if (generation !== requestedGeneration) return
    }

    const results = await Promise.allSettled(
      axes.map((axis, index) => ensureAttached(axis, names[index] as string))
    )
    const failure = results.find((result) => result.status === "rejected")
    if (failure?.status === "rejected") throw failure.reason
  }

  const runReconciliation = () => {
    requestedGeneration += 1
    if (reconciling) return
    reconciling = true

    void (async () => {
      try {
        while (completedGeneration !== requestedGeneration) {
          const generation = requestedGeneration
          reconcileFailed = false
          reportStatus()
          try {
            await reconcileOnce(generation)
          } catch (error) {
            reportLifecycleError(error)
            reconcileFailed = true
          }
          completedGeneration = generation
        }
      } finally {
        reconciling = false
      }
      reportStatus()
      closeGaps()
    })()
  }

  const onConnectionChange: AblyConnectionListener = (change) => {
    if (isAuthError(change.reason)) authorizedNames = null
    if (UNAVAILABLE_CONNECTION_STATES.has(change.current)) {
      connectionLost = true
    } else if (change.current === "connected" && connectionLost) {
      connectionLost = false
      requestGap(null)
      runReconciliation()
    }
    reportStatus()
    closeGaps()
  }

  const startMonitoring = () => {
    monitoring = true
    connectionLost = UNAVAILABLE_CONNECTION_STATES.has(
      realtime.connection.state
    )
    realtime.connection.on(onConnectionChange)
  }

  const stopMonitoring = () => {
    monitoring = false
    realtime.connection.off(onConnectionChange)
  }

  const adapter: AblyInvalidationAdapter = {
    get initialStatus() {
      return deriveStatus()
    },
    subscribe(subscription) {
      const entry: SubscriptionEntry = {
        subscription,
        reported: deriveStatus(),
        awaitingGap: true,
      }
      entries.add(entry)
      if (entries.size === 1) startMonitoring()
      reportStatus()
      runReconciliation()

      return () => {
        if (!entries.delete(entry)) return
        if (entries.size === 0) stopMonitoring()
        if (!releaseScheduled) {
          releaseScheduled = true
          queueMicrotask(releaseUnobservedChannels)
        }
        reportStatus()
        runReconciliation()
      }
    },
    retry: runReconciliation,
  }

  return {
    adapter,
    axesForChannels: (names) =>
      observedAxes().filter((axis) => {
        const name = resolvedNames.get(axis)
        return name !== undefined && names.has(name)
      }),
  }
}

/**
 * The `authCallback` Headcanon gives the realtime client. Ably calls it for
 * each `authorize()` and for token renewal, with the token parameters of the
 * last `authorize()`.
 * @param params Ably's token parameters; `capability` arrives as an object or as JSON.
 * @param callback Ably's completion callback: an error message, or the signed token request.
 * @returns Nothing; the outcome reaches Ably through `callback`.
 */
export type AblyAuthCallback = (
  params: { readonly capability?: string | Readonly<Record<string, unknown>> },
  callback: (
    error: string | null,
    tokenRequest: AblyTokenRequest | null
  ) => void
) => void

/**
 * Client options Headcanon requires. Spread them into the SDK constructor
 * unchanged: `autoConnect: false` leaves the first connection to the
 * adapter's first `authorize()`, once it knows the exact channel set.
 */
export interface AblyRealtimeOptions {
  readonly autoConnect: false
  readonly authCallback: AblyAuthCallback
}

/** Options for {@link createAblyAxisInvalidations}. */
export interface AblyAxisInvalidationsOptions {
  /**
   * The deployment namespace the publisher uses, or a loader that resolves
   * it on first subscription. A loader that resolves `null` means realtime
   * is unavailable: subscriptions report `unavailable` and no client is
   * created.
   */
  readonly namespace: string | (() => Promise<string | null>)
  /**
   * Creates the realtime client on first subscription. Spread `options` into
   * the constructor, and import the SDK here so it stays out of the first
   * bundle: `async (options) => new (await import("ably")).Realtime(options)`,
   * or `BaseRealtime` from `ably/modular` with `{ ...options, plugins }`.
   */
  readonly createRealtime: (
    options: AblyRealtimeOptions
  ) => AblyRealtimeClient | Promise<AblyRealtimeClient>
  /**
   * Fetches a signed token request for exactly these axes from the
   * application's token endpoint, which checks them and signs with
   * `createAblyAxisTokenRequest`. Called for the first authorization, each
   * change to the observed axes, and Ably's token renewal. Reject to fail
   * authorization; the adapter then reports `unavailable` until `retry()`.
   */
  readonly requestToken: (axes: readonly AxisId[]) => Promise<AblyTokenRequest>
  /** Receives each inbound message the adapter drops. */
  readonly onMalformedMessage?: (error: AblyInvalidationMessageError) => void
  /** Receives authorization, attachment, and detachment failures. */
  readonly onLifecycleError?: (error: unknown) => void
  /** Receives a failure to resolve the namespace or create the client. */
  readonly onInitializationError?: (error: unknown) => void
}

function channelNamesOf(
  capability: string | Readonly<Record<string, unknown>> | undefined
): ReadonlySet<string> {
  if (typeof capability !== "string")
    return new Set(Object.keys(capability ?? {}))
  try {
    const parsed: unknown = JSON.parse(capability)
    return new Set(
      typeof parsed === "object" && parsed !== null ? Object.keys(parsed) : []
    )
  } catch {
    return new Set()
  }
}

/**
 * Turns either namespace form into one parsed loader. A string is parsed now,
 * so an invalid one fails at construction.
 */
function namespaceResolver(
  namespace: AblyAxisInvalidationsOptions["namespace"]
): () => Promise<AblyChannelNamespace | null> {
  if (typeof namespace === "string") {
    const parsed = ablyChannelNamespace(namespace)
    return async () => parsed
  }
  return async () => {
    const loaded = await namespace()
    return loaded === null ? null : ablyChannelNamespace(loaded)
  }
}

/**
 * Creates the browser's Ably invalidation transport: the standard path, built
 * on {@link createAblyInvalidationAdapter}.
 *
 * Nothing loads until the first subscription. Then the namespace resolves,
 * `createRealtime` creates the client, and the adapter authorizes exactly the
 * observed axes' channels. Ably's `authCallback` is translated back into
 * those axes before `requestToken` sees it, so the application's endpoint
 * checks axes, never hashed channel names. A channel the adapter does not
 * observe when Ably asks is dropped, so a token is never wider than the
 * observed set at request time. As with the adapter, removing every
 * subscription requests no narrower token: the last one stays until it
 * expires or the next authorization replaces it.
 *
 * `retry()` reruns a failed start (namespace, client, or a `null` namespace
 * that may now resolve) and otherwise retries authorization and attachment.
 * Share one instance per tab. Wrap it with `withPollingFallback` for roots
 * that should poll while push is degraded, and with `withVisibilityRefresh`
 * for roots that should refresh when the viewer returns to the page; both
 * wrappers keep `retry()`.
 *
 * @param options Namespace, client factory, token request, and diagnostics.
 * @returns A retryable invalidation adapter that starts on first subscription.
 * @throws Error at construction when a string `namespace` is invalid (see `ablyChannelNamespace`).
 */
export function createAblyAxisInvalidations(
  options: AblyAxisInvalidationsOptions
): RetryableInvalidationAdapter {
  const resolveNamespace = namespaceResolver(options.namespace)
  let core: AblyAdapterCore | null = null

  /**
   * One client's `authCallback`, bound to that client's own adapter: a client
   * abandoned by a failed start keeps no subscriptions, so it can never
   * borrow a later client's observed axes for a token.
   */
  const authCallbackFor =
    (owner: { core: AblyAdapterCore | null }): AblyAuthCallback =>
    (params, callback) => {
      const names = channelNamesOf(params.capability)
      const axes = owner.core?.axesForChannels(names) ?? []
      if (axes.length === 0) {
        callback("No observed axes to authorize", null)
        return
      }
      options.requestToken(axes).then(
        (tokenRequest) => callback(null, tokenRequest),
        (error: unknown) =>
          callback(
            error instanceof Error
              ? error.message
              : "Realtime authorization failed",
            null
          )
      )
    }

  const lazy = createRestartableLazyAdapter({
    async initialize() {
      core = null
      // Resolved and parsed before the client exists, so a bad namespace
      // never leaves an orphaned connection behind.
      const namespace = await resolveNamespace()
      if (namespace === null) return null
      const owner: { core: AblyAdapterCore | null } = { core: null }
      const realtime = await options.createRealtime({
        autoConnect: false,
        authCallback: authCallbackFor(owner),
      })
      owner.core = createAblyAdapterCore({
        realtime,
        namespace,
        onMalformedMessage: options.onMalformedMessage,
        onLifecycleError: options.onLifecycleError,
      })
      core = owner.core
      return core.adapter
    },
    onInitializationError: options.onInitializationError,
  })

  return {
    get initialStatus() {
      return lazy.initialStatus
    },
    subscribe: lazy.subscribe,
    retry() {
      if (!lazy.restart()) core?.adapter.retry()
    },
  }
}
