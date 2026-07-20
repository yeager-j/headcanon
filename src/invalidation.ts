import type { AcceptedStamp, AxisId, Revision } from "./revisions"

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
}

export interface InvalidationAdapter {
  readonly initialStatus: InvalidationStatus
  subscribe(subscription: InvalidationSubscription): () => void
}

/** Fans one committed vector out as singleton axis invalidation entries. */
export interface InvalidationPublisher {
  publish(eventId: string, stamp: AcceptedStamp): void | Promise<void>
}
