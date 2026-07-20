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

export type InvalidationStatus =
  | "disabled"
  | "active"
  | "reauthorizing"
  | "polling"
  | "unavailable"

export interface InvalidationSubscription {
  readonly axes: readonly AxisId[]
  readonly onInvalidation: (invalidation: AxisInvalidation) => void
  readonly onStatusChange: (status: InvalidationStatus) => void
  readonly onSubscriptionGap?: () => void
}

export interface InvalidationAdapter {
  readonly initialStatus: InvalidationStatus
  subscribe(subscription: InvalidationSubscription): () => void
}

/** Fans one committed vector out as singleton axis invalidation entries. */
export interface InvalidationPublisher {
  publish(eventId: string, stamp: AcceptedStamp): void | Promise<void>
}

export interface InvalidationPublicationFailure {
  readonly kind: "rejected" | "timed-out"
  readonly eventId: string
  readonly stamp: AcceptedStamp
  readonly error?: unknown
}

export type InvalidationPublicationFailureReporter = (
  failure: InvalidationPublicationFailure
) => void

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

/** Parses one untrusted realtime payload without admitting domain data. */
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
