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
  /**
   * ID of the publication that produced this entry; every entry fanned out
   * from one accepted stamp shares it.
   */
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
  /** Subscribes to `subscription.axes` and returns the function that ends the subscription. */
  subscribe(subscription: InvalidationSubscription): () => void
}

/** An invalidation adapter whose transport the application can ask to recover. */
export interface RetryableInvalidationAdapter extends InvalidationAdapter {
  /** Asks the transport to recover after `unavailable`; does nothing while it is healthy. */
  retry(): void
}

/** Initialization and diagnostics supplied to the lazy transport adapter. */
export interface LazyInvalidationAdapterOptions {
  /**
   * Creates the transport. Called at most once, on the first subscription.
   * Resolve `null` when no transport is available.
   */
  readonly initialize: () => Promise<InvalidationAdapter | null>
  /**
   * Receives the error when initialization fails: `initialize` throws or
   * rejects, or forwarding a buffered subscription to the new transport
   * throws. Not called when `initialize` resolves `null`.
   */
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
  const lazy = createRestartableLazyAdapter(options)
  return {
    get initialStatus() {
      return lazy.initialStatus
    },
    subscribe: lazy.subscribe,
  }
}

/** A lazy adapter that can run its initialization again after it failed. */
export interface RestartableLazyAdapter extends InvalidationAdapter {
  /**
   * Runs initialization again when the last attempt failed or found no
   * transport, and forwards every live subscription once it succeeds.
   * @returns Whether a new attempt started; false while initializing or ready.
   */
  restart(): boolean
}

/**
 * The lazy adapter behind {@link createLazyInvalidationAdapter}, plus
 * `restart()`. Not a package export: the public lazy adapter initializes at
 * most once, and only `createAblyAxisInvalidations` offers a restart, through
 * its `retry()`. Until the transport is ready, live subscriptions wait here,
 * including while unavailable, so a restart can forward them.
 * @param options Initialization callback and optional diagnostics handler.
 * @returns A lazy adapter with a `restart()` control.
 */
export function createRestartableLazyAdapter(
  options: LazyInvalidationAdapterOptions
): RestartableLazyAdapter {
  type BufferedSubscription = {
    readonly subscription: InvalidationSubscription
    cancelled: boolean
    unsubscribe: (() => void) | null
  }

  let state: "idle" | "initializing" | "ready" | "unavailable" = "idle"
  let inner: InvalidationAdapter | null = null
  const buffered = new Set<BufferedSubscription>()

  const becomeUnavailable = (): void => {
    state = "unavailable"
    for (const entry of [...buffered]) {
      // A status callback may restart; the rest then learn the new attempt's
      // status from `restart()`, not this stale one.
      if (state !== "unavailable") return
      if (!entry.cancelled) entry.subscription.onStatusChange("unavailable")
    }
  }

  /** Releases an entry's transport subscription at most once. */
  const release = (entry: BufferedSubscription): void => {
    const unsubscribe = entry.unsubscribe
    entry.unsubscribe = null
    unsubscribe?.()
  }

  const initialize = async (): Promise<void> => {
    const forwarded: BufferedSubscription[] = []
    try {
      inner = await options.initialize()
      if (!inner) {
        becomeUnavailable()
        return
      }

      // Still `initializing` while forwarding: a subscription a status
      // callback makes now waits in the buffer, and this live iteration
      // forwards it in the same pass, so a rollback covers it too.
      for (const entry of buffered) {
        const status = inner.initialStatus
        if (!entry.cancelled && status !== "reauthorizing") {
          entry.subscription.onStatusChange(status)
        }
        // The status callback may have cancelled this subscription.
        if (!entry.cancelled) {
          entry.unsubscribe = inner.subscribe(entry.subscription)
          forwarded.push(entry)
        }
        buffered.delete(entry)
      }
      state = "ready"
    } catch (error) {
      // A failed attempt keeps no subscriptions on its transport: every live
      // one waits here again, so a restart forwards all of them to the next.
      for (const entry of forwarded) {
        try {
          release(entry)
        } catch (cleanupError) {
          options.onInitializationError?.(cleanupError)
        }
        if (!entry.cancelled) buffered.add(entry)
      }
      if (error !== undefined) options.onInitializationError?.(error)
      becomeUnavailable()
    }
  }

  const start = (): void => {
    state = "initializing"
    void initialize()
  }

  return {
    get initialStatus() {
      if (state === "ready" && inner) return inner.initialStatus
      return state === "unavailable" ? "unavailable" : "reauthorizing"
    },
    subscribe(subscription) {
      if (state === "ready" && inner) return inner.subscribe(subscription)

      const entry: BufferedSubscription = {
        subscription,
        cancelled: false,
        unsubscribe: null,
      }
      buffered.add(entry)
      if (state === "unavailable") subscription.onStatusChange("unavailable")
      if (state === "idle") start()

      return () => {
        entry.cancelled = true
        buffered.delete(entry)
        release(entry)
      }
    },
    restart() {
      if (state !== "unavailable") return false
      inner = null
      state = "initializing"
      for (const entry of [...buffered]) {
        if (!entry.cancelled) entry.subscription.onStatusChange("reauthorizing")
      }
      start()
      return true
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
  /** Milliseconds between gap reports while the primary is degraded; finite and positive. */
  readonly intervalMs: number
  /**
   * Whether to skip gap reports while the document is hidden, and report one
   * gap when it becomes visible again while polling. Defaults to `true`. Has
   * no effect where `document` is undefined.
   */
  readonly pauseWhenHidden?: boolean
}

function pollingStatus(status: InvalidationStatus): InvalidationStatus {
  return isDegradedInvalidationStatus(status) ? "polling" : status
}

/**
 * Whether the browser reports that it has no network. False where `navigator`
 * or `navigator.onLine` is undefined, such as on the server.
 *
 * A refresh requested while offline can cost the page: Next's router answers
 * a failed refresh with a full-page load, which drops in-memory state.
 */
function browserIsOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false
}

/**
 * Wraps an invalidation adapter so a root keeps refreshing while push delivery
 * is degraded.
 *
 * While the primary reports `disabled`, `reauthorizing`, or `unavailable`, the
 * wrapper reports `polling` and calls `onSubscriptionGap` every `intervalMs`,
 * so the root refreshes through its usual carrier. When the primary reports
 * `active`, polling stops and the primary's status is forwarded. Unsubscribing
 * stops the timer. A primary with `retry()` keeps it: the wrapper forwards
 * it, so wrapping does not hide the transport's recovery control.
 *
 * While the browser reports it is offline (`navigator.onLine === false`), the
 * wrapper skips its gap reports. When the browser's `online` event fires
 * while polling, it reports one gap at once.
 *
 * @param primary Push invalidation adapter to wrap.
 * @param options Polling interval and visibility policy.
 * @returns An invalidation adapter with polling fallback, retryable when `primary` is.
 * @throws Error when `intervalMs` is not a finite positive number.
 */
export function withPollingFallback(
  primary: RetryableInvalidationAdapter,
  options: PollingFallbackOptions
): RetryableInvalidationAdapter
export function withPollingFallback(
  primary: InvalidationAdapter,
  options: PollingFallbackOptions
): InvalidationAdapter
export function withPollingFallback(
  primary: InvalidationAdapter | RetryableInvalidationAdapter,
  options: PollingFallbackOptions
): InvalidationAdapter {
  if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
    throw new Error("Polling fallback intervalMs must be positive")
  }

  const pauseWhenHidden = options.pauseWhenHidden ?? true

  return {
    ...("retry" in primary && { retry: () => primary.retry() }),
    get initialStatus() {
      return pollingStatus(primary.initialStatus)
    },
    subscribe(subscription) {
      const watchesVisibility =
        pauseWhenHidden && typeof document !== "undefined"
      const watchesConnectivity = typeof window !== "undefined"
      let polling = isDegradedInvalidationStatus(primary.initialStatus)
      let stopped = false
      let interval: ReturnType<typeof setInterval> | null = null

      const pausedWhileHidden = () =>
        watchesVisibility && document.visibilityState === "hidden"
      const mayPoll = () => !stopped && polling && !pausedWhileHidden()

      const stopInterval = () => {
        if (interval === null) return
        clearInterval(interval)
        interval = null
      }

      const requestRefresh = () => {
        if (mayPoll() && !browserIsOffline()) subscription.onSubscriptionGap?.()
      }

      const startInterval = () => {
        if (!mayPoll() || interval !== null) return
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
        if (pausedWhileHidden()) {
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

      if (watchesVisibility) {
        document.addEventListener("visibilitychange", onVisibilityChange)
      }

      if (watchesConnectivity) {
        window.addEventListener("online", requestRefresh)
      }

      return () => {
        if (stopped) return
        stopped = true
        stopInterval()
        if (watchesVisibility) {
          document.removeEventListener("visibilitychange", onVisibilityChange)
        }

        if (watchesConnectivity) {
          window.removeEventListener("online", requestRefresh)
        }

        stopPrimary()
      }
    },
  }
}

/**
 * Wraps an invalidation adapter so a root refreshes when the user returns to
 * the page.
 *
 * Each time the document becomes visible, the wrapper calls every
 * subscription's `onSubscriptionGap`, whatever the transport's status, so the
 * root runs one refresh through its usual carrier even while push delivery is
 * `active`. While the browser reports it is offline
 * (`navigator.onLine === false`), the wrapper holds that report and sends it
 * when the browser's `online` event fires, if the document is still visible.
 *
 * Statuses and invalidations pass through unchanged, and a primary's
 * `retry()` is forwarded. The wrapper composes with
 * {@link withPollingFallback} in either order: gap reports that arrive
 * together become one refresh. Where `document` is undefined, it returns the
 * primary's subscriptions unchanged.
 *
 * @param primary Invalidation adapter to wrap. For a root with no push
 *   transport, wrap `createNoRealtimeInvalidationAdapter()`.
 * @returns An invalidation adapter that reports a gap on each return to the
 *   page, retryable when `primary` is.
 * @example
 * ```ts
 * export const axisInvalidations = withVisibilityRefresh(
 *   withPollingFallback(pushInvalidations, { intervalMs: 15_000 })
 * )
 * ```
 */
export function withVisibilityRefresh(
  primary: RetryableInvalidationAdapter
): RetryableInvalidationAdapter
export function withVisibilityRefresh(
  primary: InvalidationAdapter
): InvalidationAdapter
export function withVisibilityRefresh(
  primary: InvalidationAdapter | RetryableInvalidationAdapter
): InvalidationAdapter {
  return {
    ...("retry" in primary && { retry: () => primary.retry() }),
    get initialStatus() {
      return primary.initialStatus
    },
    subscribe(subscription) {
      const stopPrimary = primary.subscribe(subscription)
      if (typeof document === "undefined") return stopPrimary

      let stopped = false
      let heldWhileOffline = false

      const isVisible = () => document.visibilityState === "visible"

      const onVisibilityChange = () => {
        if (!isVisible()) return

        if (browserIsOffline()) {
          heldWhileOffline = true
          return
        }

        subscription.onSubscriptionGap?.()
      }

      const onOnline = () => {
        if (!heldWhileOffline) return

        heldWhileOffline = false
        if (isVisible()) subscription.onSubscriptionGap?.()
      }

      document.addEventListener("visibilitychange", onVisibilityChange)
      window.addEventListener("online", onOnline)

      return () => {
        if (stopped) return
        stopped = true
        document.removeEventListener("visibilitychange", onVisibilityChange)
        window.removeEventListener("online", onOnline)
        stopPrimary()
      }
    },
  }
}

/** Fans one committed vector out as singleton axis invalidation entries. */
export interface InvalidationPublisher {
  /**
   * Publishes one entry per axis in `stamp`, each carrying `eventId`. A
   * rejection or a slow result is reported as a publication failure and does
   * not fail the accepted mutation.
   */
  publish(eventId: string, stamp: AcceptedStamp): void | Promise<void>
}

/** Diagnostic record for an invalidation publication that did not complete. */
export interface InvalidationPublicationFailure {
  readonly kind: "rejected" | "timed-out"
  readonly eventId: string
  readonly stamp: AcceptedStamp
  /** The rejection reason; present only when `kind` is `rejected`. */
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
