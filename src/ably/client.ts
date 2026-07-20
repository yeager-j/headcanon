import {
  axisInvalidation,
  type AxisInvalidationValidationError,
  type InvalidationAdapter,
  type InvalidationStatus,
  type InvalidationSubscription,
} from "../invalidation"
import type { AxisId } from "../revisions"
import {
  ABLY_AXIS_INVALIDATION_EVENT,
  ablyAxisChannelName,
  ablySubscribeCapability,
} from "./channels"

interface AblyMessage {
  readonly data?: unknown
}

type AblyMessageListener = (message: AblyMessage) => void

export interface AblyRealtimeChannel {
  subscribe(name: string, listener: AblyMessageListener): Promise<unknown>
  unsubscribe(name: string, listener: AblyMessageListener): void
  attach(): Promise<unknown>
  detach(): Promise<unknown>
}

export interface AblyRealtimeClient {
  readonly auth: {
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

type AblyConnectionEvent =
  | "connected"
  | "disconnected"
  | "suspended"
  | "closed"
  | "failed"

type AblyConnectionListener = (change: unknown) => void

export interface AblyRealtimeConnection {
  readonly state: string
  on(event: AblyConnectionEvent, listener: AblyConnectionListener): void
  on(events: AblyConnectionEvent[], listener: AblyConnectionListener): void
  off(event: AblyConnectionEvent, listener: AblyConnectionListener): void
  off(events: AblyConnectionEvent[], listener: AblyConnectionListener): void
}

export interface AblyInvalidationAdapter extends InvalidationAdapter {
  retry(): void
  settled(): Promise<void>
}

interface ActiveChannel {
  readonly axis: AxisId
  readonly channel: AblyRealtimeChannel
  readonly listener: AblyMessageListener
}

function observedAxes(
  subscriptions: ReadonlySet<InvalidationSubscription>
): readonly AxisId[] {
  return [...new Set([...subscriptions].flatMap(({ axes }) => axes))].sort()
}

function sameNames(
  left: ReadonlyMap<string, ActiveChannel>,
  right: ReadonlyMap<string, AxisId>
): boolean {
  if (left.size !== right.size) return false
  for (const name of left.keys()) {
    if (!right.has(name)) return false
  }
  return true
}

function sameAxes(
  activeChannels: ReadonlyMap<string, ActiveChannel>,
  desiredAxes: readonly AxisId[]
): boolean {
  const activeAxes = new Set(
    [...activeChannels.values()].map(({ axis }) => axis)
  )
  return (
    activeAxes.size === desiredAxes.length &&
    desiredAxes.every((axis) => activeAxes.has(axis))
  )
}

/** Owns exact-set authorization, attachment, and gap recovery for mounted roots. */
export function createAblyInvalidationAdapter(options: {
  readonly realtime: AblyRealtimeClient
  readonly namespace: string
  readonly onMalformedMessage?: (error: AxisInvalidationValidationError) => void
  readonly onLifecycleError?: (error: unknown) => void
}): AblyInvalidationAdapter {
  const subscriptions = new Set<InvalidationSubscription>()
  const activeChannels = new Map<string, ActiveChannel>()
  const axesAwaitingGapClosure = new Set<AxisId>()
  let status: InvalidationStatus = "reauthorizing"
  let requestedGeneration = 0
  let completedGeneration = 0
  let reconciliation: Promise<void> | null = null
  let monitoringConnection = false
  let closeGapAfterReconcile = false
  let connectionUnavailable = false

  const reportLifecycleError = (error: unknown) => {
    try {
      options.onLifecycleError?.(error)
    } catch {
      // Diagnostics must not take ownership of the subscription lifecycle.
    }
  }

  const reportMalformedMessage = (error: AxisInvalidationValidationError) => {
    try {
      options.onMalformedMessage?.(error)
    } catch {
      // An observer cannot turn rejected input into a channel-listener failure.
    }
  }

  const setStatus = (next: InvalidationStatus) => {
    if (status === next) return
    status = next
    for (const subscription of subscriptions) {
      subscription.onStatusChange(next)
    }
  }

  const removeChannel = async (
    name: string,
    active: ActiveChannel
  ): Promise<void> => {
    active.channel.unsubscribe(ABLY_AXIS_INVALIDATION_EVENT, active.listener)
    activeChannels.delete(name)
    axesAwaitingGapClosure.delete(active.axis)
    try {
      await active.channel.detach()
    } catch (error) {
      reportLifecycleError(error)
    }
  }

  const reconcileOnce = async (generation: number): Promise<void> => {
    setStatus("reauthorizing")
    const axes = observedAxes(subscriptions)
    const desiredEntries = await Promise.all(
      axes.map(
        async (axis) =>
          [await ablyAxisChannelName(options.namespace, axis), axis] as const
      )
    )
    const desiredChannels = new Map(desiredEntries)
    if (generation !== requestedGeneration) return

    await options.realtime.auth.authorize({
      capability: ablySubscribeCapability([...desiredChannels.keys()]),
    })
    if (generation !== requestedGeneration) return

    const removed = [...activeChannels].filter(
      ([name]) => !desiredChannels.has(name)
    )
    await Promise.all(
      removed.map(([name, active]) => removeChannel(name, active))
    )

    const added = [...desiredChannels].filter(
      ([name]) => !activeChannels.has(name)
    )
    const attachmentResults = await Promise.allSettled(
      added.map(async ([name, axis]) => {
        const channel = options.realtime.channels.get(name, {
          attachOnSubscribe: false,
        })
        const listener: AblyMessageListener = (message) => {
          const parsed = axisInvalidation(message.data)
          if (!parsed.ok) {
            reportMalformedMessage(parsed.error)
            return
          }
          if (parsed.value.axis !== axis) {
            reportMalformedMessage({
              code: "invalid-axis-invalidation",
              reason: "invalid-axis",
              value: message.data,
            })
            return
          }

          for (const subscription of subscriptions) {
            if (!subscription.axes.includes(axis)) continue
            subscription.onInvalidation(parsed.value)
          }
        }

        try {
          await channel.subscribe(ABLY_AXIS_INVALIDATION_EVENT, listener)
          await channel.attach()
        } catch (error) {
          channel.unsubscribe(ABLY_AXIS_INVALIDATION_EVENT, listener)
          throw error
        }
        return [name, { axis, channel, listener }] as const
      })
    )
    for (const result of attachmentResults) {
      if (result.status === "fulfilled") {
        const [name, active] = result.value
        activeChannels.set(name, active)
        axesAwaitingGapClosure.add(active.axis)
      }
    }
    const attachmentFailure = attachmentResults.find(
      (result) => result.status === "rejected"
    )
    if (attachmentFailure?.status === "rejected") {
      throw attachmentFailure.reason
    }

    if (generation !== requestedGeneration) return
    if (!sameNames(activeChannels, desiredChannels)) return
    if (connectionUnavailable) return
    setStatus("active")
    const closesConnectionGap = closeGapAfterReconcile
    if (axesAwaitingGapClosure.size > 0 || closesConnectionGap) {
      for (const subscription of subscriptions) {
        if (
          !closesConnectionGap &&
          !subscription.axes.some((axis) => axesAwaitingGapClosure.has(axis))
        ) {
          continue
        }
        subscription.onSubscriptionGap?.()
      }
    }
    axesAwaitingGapClosure.clear()
    closeGapAfterReconcile = false
  }

  const runReconciliation = () => {
    requestedGeneration += 1
    if (reconciliation) return

    reconciliation = (async () => {
      while (completedGeneration !== requestedGeneration) {
        const generation = requestedGeneration
        try {
          await reconcileOnce(generation)
        } catch (error) {
          reportLifecycleError(error)
          setStatus("unavailable")
        }
        completedGeneration = generation
      }
    })().finally(() => {
      reconciliation = null
      if (completedGeneration !== requestedGeneration) runReconciliation()
    })
  }

  const unavailableConnectionStates: AblyConnectionEvent[] = [
    "disconnected",
    "suspended",
    "closed",
    "failed",
  ]
  const handleConnectionUnavailable: AblyConnectionListener = () => {
    connectionUnavailable = true
    setStatus("unavailable")
  }
  const handleConnectionConnected: AblyConnectionListener = () => {
    if (!connectionUnavailable) return
    connectionUnavailable = false
    closeGapAfterReconcile = true
    runReconciliation()
  }
  const startConnectionMonitoring = () => {
    if (monitoringConnection) return
    monitoringConnection = true
    options.realtime.connection.on(
      unavailableConnectionStates,
      handleConnectionUnavailable
    )
    options.realtime.connection.on("connected", handleConnectionConnected)
    if (
      unavailableConnectionStates.includes(
        options.realtime.connection.state as AblyConnectionEvent
      )
    ) {
      handleConnectionUnavailable(undefined)
    } else if (options.realtime.connection.state === "connected") {
      connectionUnavailable = false
    }
  }
  const stopConnectionMonitoring = () => {
    if (!monitoringConnection) return
    monitoringConnection = false
    options.realtime.connection.off(
      unavailableConnectionStates,
      handleConnectionUnavailable
    )
    options.realtime.connection.off("connected", handleConnectionConnected)
  }

  return {
    get initialStatus() {
      return status
    },
    subscribe(subscription) {
      const wasEmpty = subscriptions.size === 0
      subscriptions.add(subscription)
      if (wasEmpty) startConnectionMonitoring()
      if (
        !sameAxes(activeChannels, observedAxes(subscriptions)) &&
        status !== "reauthorizing"
      ) {
        setStatus("reauthorizing")
      } else {
        subscription.onStatusChange(status)
      }
      runReconciliation()
      return () => {
        subscriptions.delete(subscription)
        if (subscriptions.size === 0) stopConnectionMonitoring()
        if (
          !sameAxes(activeChannels, observedAxes(subscriptions)) &&
          status !== "reauthorizing"
        ) {
          setStatus("reauthorizing")
        }
        runReconciliation()
      }
    },
    retry: runReconciliation,
    async settled() {
      while (reconciliation) await reconciliation
    },
  }
}
