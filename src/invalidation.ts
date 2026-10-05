import { err, ok, type Result } from "serializable-result"

import { hasExactKeys, isPlainRecord } from "./admission"
import {
  axisId,
  isAxisAddress,
  revision,
  type AcceptedStamp,
  type AxisId,
  type Revision,
  type RevisionValidationError,
} from "./revisions"

/** One singleton revision notification on a globally stable axis. */
export interface AxisInvalidation {
  readonly eventId: string
  readonly axis: AxisId
  readonly revision: Revision
}

/**
 * What a root may assume about push invalidations right now. This is the one
 * definition of each status; transports and wrappers only choose when to
 * report it.
 *
 * - `active`: the transport is attached for every subscribed axis and delivers
 *   their invalidations.
 * - `reauthorizing`: the transport is acquiring authorization or attachment
 *   for the current axis set — including first-time initialization — and may
 *   miss invalidations until it reports `active`.
 * - `unavailable`: the transport failed; invalidations are being missed until
 *   it recovers or is retried.
 * - `disabled`: the root deliberately has no push transport (configuration,
 *   not a failure).
 * - `polling`: reported only by a polling fallback wrapper while its primary
 *   transport is degraded; refreshes are requested on an interval instead.
 *
 * `disabled`, `reauthorizing`, and `unavailable` are the degraded statuses
 * (see {@link isDegradedInvalidationStatus}).
 */
export type InvalidationStatus =
  | "disabled"
  | "active"
  | "reauthorizing"
  | "polling"
  | "unavailable"

/**
 * Returns whether push delivery cannot be trusted in a status, so a root needs
 * another liveness source such as polling.
 * @param status Status reported by an invalidation adapter.
 * @returns Whether the status is `disabled`, `reauthorizing`, or `unavailable`.
 */
export function isDegradedInvalidationStatus(
  status: InvalidationStatus
): boolean {
  return (
    status === "disabled" ||
    status === "reauthorizing" ||
    status === "unavailable"
  )
}

/** Root-owned subscription callbacks for a set of revision axes. */
export interface InvalidationSubscription {
  readonly axes: readonly AxisId[]
  readonly onInvalidation: (invalidation: AxisInvalidation) => void
  readonly onStatusChange: (status: InvalidationStatus) => void
  /**
   * Reports that invalidations for these axes may have been missed before this
   * call (for example across a reattachment), with no revision to say which.
   * The root then needs one refresh that starts after the call and succeeds;
   * a failed refresh leaves the gap open.
   */
  readonly onSubscriptionGap?: () => void
}

/**
 * Synchronous subscription seam implemented by push or fallback transports.
 *
 * A consumer reads `initialStatus` immediately before each `subscribe` call:
 * it is the status the new subscription starts in, so it may change over the
 * adapter's lifetime (implement it as a getter when it does). After that, the
 * adapter reports every change through `onStatusChange`, possibly
 * synchronously inside `subscribe`. Reporting the current status again is
 * allowed and must be harmless to consumers.
 */
export interface InvalidationAdapter {
  /** Status a subscription made now starts in; read at subscribe time. */
  readonly initialStatus: InvalidationStatus
  subscribe(subscription: InvalidationSubscription): () => void
}

/** Initialization and diagnostics supplied to the lazy transport adapter. */
export interface LazyInvalidationAdapterOptions {
  readonly initialize: () => Promise<InvalidationAdapter | null>
  readonly onInitializationError?: (error: unknown) => void
}

/**
 * Adapts an asynchronously-created transport to the synchronous root seam,
 * for example one that lazily imports a realtime SDK.
 *
 * Initialization happens at most once, on the first subscription. Until it
 * completes, the adapter reports `reauthorizing` and buffers subscriptions;
 * cancelling one before readiness prevents it from ever reaching the
 * transport. When the inner adapter is ready, each buffered subscription
 * receives the inner adapter's `initialStatus` (when it differs) and is then
 * subscribed to it, and `initialStatus` forwards the inner adapter's from then
 * on. A `null` result or a rejected initialization reports `unavailable`.
 * @param options Initialization callback and optional diagnostics handler.
 * @returns An invalidation adapter that buffers subscriptions until ready.
 */
export function createLazyInvalidationAdapter(
  options: LazyInvalidationAdapterOptions
): InvalidationAdapter {
  type BufferedSubscription = {
    readonly subscription: InvalidationSubscription
    cancelled: boolean
    unsubscribe: (() => void) | null
  }

  let state: "idle" | "initializing" | "ready" | "unavailable" = "idle"
  let inner: InvalidationAdapter | null = null
  const buffered = new Set<BufferedSubscription>()

  const becomeUnavailable = (error?: unknown): void => {
    if (error !== undefined) options.onInitializationError?.(error)
    state = "unavailable"
    for (const entry of buffered) {
      if (!entry.cancelled) entry.subscription.onStatusChange("unavailable")
    }
    buffered.clear()
  }

  const initialize = async (): Promise<void> => {
    try {
      inner = await options.initialize()
      if (!inner) {
        becomeUnavailable()
        return
      }

      state = "ready"
      for (const entry of buffered) {
        const status = inner.initialStatus
        if (!entry.cancelled && status !== "reauthorizing") {
          entry.subscription.onStatusChange(status)
        }
        // The status callback may have cancelled this subscription.
        if (!entry.cancelled) {
          entry.unsubscribe = inner.subscribe(entry.subscription)
        }
      }
      buffered.clear()
    } catch (error) {
      becomeUnavailable(error)
    }
  }

  return {
    get initialStatus() {
      if (state === "ready" && inner) return inner.initialStatus
      return state === "unavailable" ? "unavailable" : "reauthorizing"
    },
    subscribe(subscription) {
      if (state === "ready" && inner) return inner.subscribe(subscription)
      if (state === "unavailable") {
        subscription.onStatusChange("unavailable")
        return () => undefined
      }

      const entry: BufferedSubscription = {
        subscription,
        cancelled: false,
        unsubscribe: null,
      }
      buffered.add(entry)
      if (state === "idle") {
        state = "initializing"
        void initialize()
      }

      return () => {
        entry.cancelled = true
        entry.unsubscribe?.()
        buffered.delete(entry)
      }
    },
  }
}

/**
 * Declares that a root intentionally has no push-invalidation transport.
 * @returns An adapter that reports `disabled` and never publishes updates.
 */
export function createNoRealtimeInvalidationAdapter(): InvalidationAdapter {
  return {
    initialStatus: "disabled",
    subscribe(subscription) {
      subscription.onStatusChange("disabled")
      return () => undefined
    },
  }
}

/** Timing and visibility policy for degraded invalidation polling. */
export interface PollingFallbackOptions {
  readonly intervalMs: number
  readonly pauseWhenHidden?: boolean
}

function pollingStatus(status: InvalidationStatus): InvalidationStatus {
  return isDegradedInvalidationStatus(status) ? "polling" : status
}

/**
 * Preserves bounded liveness through the subscribed root's existing refresh
 * path whenever its primary invalidation transport is unavailable.
 *
 * The wrapper reports `polling` while the primary adapter is disabled,
 * reauthorizing, or unavailable. At the configured interval it reports a
 * subscription gap (`onSubscriptionGap`): while the primary is degraded,
 * invalidations may have been missed, which is exactly what a gap means, so
 * the root treats each tick like any other gap. It stops the timer on
 * unsubscribe and
 * can pause while the document is hidden. When the primary transport becomes
 * active, polling stops and the original status is forwarded. This is a
 * liveness fallback, not a second data source: the root still obtains state
 * only through its existing refresh carrier.
 *
 * @param primary Push invalidation adapter to wrap.
 * @param options Polling interval and visibility policy.
 * @returns An invalidation adapter with polling fallback.
 * @throws Error when `intervalMs` is not a finite positive number.
 */
export function withPollingFallback(
  primary: InvalidationAdapter,
  options: PollingFallbackOptions
): InvalidationAdapter {
  if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
    throw new Error("Polling fallback intervalMs must be positive")
  }

  const pauseWhenHidden = options.pauseWhenHidden ?? true

  return {
    get initialStatus() {
      return pollingStatus(primary.initialStatus)
    },
    subscribe(subscription) {
      let polling = isDegradedInvalidationStatus(primary.initialStatus)
      let stopped = false
      let interval: ReturnType<typeof setInterval> | null = null

      const hidden = () =>
        pauseWhenHidden &&
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"

      const stopInterval = () => {
        if (interval === null) return
        clearInterval(interval)
        interval = null
      }

      const requestRefresh = () => {
        if (!stopped && polling && !hidden()) {
          subscription.onSubscriptionGap?.()
        }
      }

      const startInterval = () => {
        if (stopped || !polling || hidden() || interval !== null) return
        interval = setInterval(requestRefresh, options.intervalMs)
      }

      const reconcileInterval = () => {
        if (polling) startInterval()
        else stopInterval()
      }

      const onStatusChange: InvalidationSubscription["onStatusChange"] = (
        status
      ) => {
        if (status === "active") polling = false
        else if (isDegradedInvalidationStatus(status)) polling = true

        reconcileInterval()
        subscription.onStatusChange(polling ? "polling" : status)
      }

      const onVisibilityChange = () => {
        if (hidden()) {
          stopInterval()
          return
        }

        requestRefresh()
        startInterval()
      }

      const stopPrimary = primary.subscribe({
        ...subscription,
        onStatusChange,
      })
      reconcileInterval()

      if (pauseWhenHidden && typeof document !== "undefined") {
        document.addEventListener("visibilitychange", onVisibilityChange)
      }

      return () => {
        if (stopped) return
        stopped = true
        stopInterval()
        if (pauseWhenHidden && typeof document !== "undefined") {
          document.removeEventListener("visibilitychange", onVisibilityChange)
        }
        stopPrimary()
      }
    },
  }
}

/** Fans one committed vector out as singleton axis invalidation entries. */
export interface InvalidationPublisher {
  publish(eventId: string, stamp: AcceptedStamp): void | Promise<void>
}

/** Diagnostic record for an invalidation publication that did not complete. */
export interface InvalidationPublicationFailure {
  readonly kind: "rejected" | "timed-out"
  readonly eventId: string
  readonly stamp: AcceptedStamp
  readonly error?: unknown
}

/**
 * Application-owned sink for publication rejection and timeout diagnostics.
 * @param failure Failure record including the accepted stamp and event ID.
 * @returns Nothing; reporter failures are ignored by finalization.
 */
export type InvalidationPublicationFailureReporter = (
  failure: InvalidationPublicationFailure
) => void

/**
 * Fail-closed reasons an untrusted axis invalidation payload was rejected.
 * An invalid revision nests the revision parser's error under `error`.
 */
export type AxisInvalidationValidationError =
  | {
      readonly code: "invalid-axis-invalidation"
      readonly reason:
        | "not-plain-object"
        | "unexpected-field"
        | "invalid-event-id"
        | "invalid-axis"
      readonly value: unknown
    }
  | {
      readonly code: "invalid-axis-invalidation"
      readonly reason: "invalid-revision"
      readonly value: unknown
      readonly error: RevisionValidationError
    }

/**
 * Parses one untrusted realtime payload without admitting domain data.
 * @param value Untrusted transport payload.
 * @returns A validated axis invalidation or a typed validation failure.
 */
export function axisInvalidation(
  value: unknown
): Result<AxisInvalidation, AxisInvalidationValidationError> {
  if (!isPlainRecord(value)) {
    return err({
      code: "invalid-axis-invalidation",
      reason: "not-plain-object",
      value,
    })
  }

  if (!hasExactKeys(value, ["eventId", "axis", "revision"])) {
    return err({
      code: "invalid-axis-invalidation",
      reason: "unexpected-field",
      value,
    })
  }

  if (typeof value.eventId !== "string" || value.eventId.length === 0) {
    return err({
      code: "invalid-axis-invalidation",
      reason: "invalid-event-id",
      value,
    })
  }
  if (!isAxisAddress(value.axis)) {
    return err({
      code: "invalid-axis-invalidation",
      reason: "invalid-axis",
      value,
    })
  }

  const parsedRevision = revision(value.revision)
  if (!parsedRevision.ok) {
    return err({
      code: "invalid-axis-invalidation",
      reason: "invalid-revision",
      value,
      error: parsedRevision.error,
    })
  }

  return ok(
    Object.freeze({
      eventId: value.eventId,
      axis: axisId(value.axis),
      revision: parsedRevision.value,
    })
  )
}
