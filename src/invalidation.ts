import { err, ok, type Result } from "@workspace/result"

import {
  axisId,
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

/** Lifecycle state reported by an invalidation transport. */
export type InvalidationStatus =
  | "disabled"
  | "active"
  | "reauthorizing"
  | "polling"
  | "unavailable"

/** Root-owned subscription callbacks for a set of revision axes. */
export interface InvalidationSubscription {
  readonly axes: readonly AxisId[]
  readonly onInvalidation: (invalidation: AxisInvalidation) => void
  readonly onStatusChange: (status: InvalidationStatus) => void
  readonly onSubscriptionGap?: () => void
}

/** Synchronous subscription seam implemented by push or fallback transports. */
export interface InvalidationAdapter {
  readonly initialStatus: InvalidationStatus
  subscribe(subscription: InvalidationSubscription): () => void
}

/** Initialization and diagnostics supplied to the lazy transport adapter. */
export interface LazyInvalidationAdapterOptions {
  readonly initialize: () => Promise<InvalidationAdapter | null>
  readonly onInitializationError?: (error: unknown) => void
}

/**
 * Adapts an asynchronously-created transport to the synchronous root seam.
 * Initialization happens at most once. Early subscriptions are buffered, and
 * cancelling one before readiness prevents it from ever reaching the transport.
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
    initialStatus: "reauthorizing",
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

/** Fail-closed reasons an untrusted axis invalidation payload was rejected. */
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
  | (Omit<RevisionValidationError, "code"> & {
      readonly code: "invalid-axis-invalidation-revision"
    })

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false
  }

  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false

  return Reflect.ownKeys(value).every((key) => {
    if (typeof key === "symbol") return false
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor?.enumerable === true && "value" in descriptor
  })
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

  const keys = Reflect.ownKeys(value)
  if (
    keys.length !== 3 ||
    !keys.every(
      (key) =>
        typeof key === "string" && ["eventId", "axis", "revision"].includes(key)
    )
  ) {
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
  if (typeof value.axis !== "string" || value.axis.length === 0) {
    return err({
      code: "invalid-axis-invalidation",
      reason: "invalid-axis",
      value,
    })
  }

  const parsedRevision = revision(value.revision)
  if (!parsedRevision.ok) {
    return err({
      ...parsedRevision.error,
      code: "invalid-axis-invalidation-revision",
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
