import type {
  AxisInvalidation,
  InvalidationAdapter,
  InvalidationPublicationFailureReporter,
  InvalidationPublisher,
  InvalidationStatus,
  InvalidationSubscription,
} from "../core/invalidation"
import { revisionEntries } from "../core/revisions"

/** Synchronous in-memory invalidation bus for contract tests and fixtures. */
export interface InMemoryInvalidationAdapter
  extends InvalidationAdapter, InvalidationPublisher {
  /**
   * A frozen snapshot of every per-axis entry published so far, in publish
   * order.
   */
  readonly published: readonly AxisInvalidation[]
  /**
   * Reports `status` to every current subscription; later subscriptions start
   * in it.
   */
  setStatus(status: InvalidationStatus): void
}

/**
 * A synchronous per-axis invalidation bus for tests and local fixtures. It has
 * no test-framework dependency. Its own `publish` never fails, so the default
 * `onFailure` does nothing; pass one when a test wraps the publisher to fail.
 * @param options Optional failure reporter for the publisher.
 * @returns An in-memory invalidation adapter and publisher.
 */
export function createInMemoryInvalidationAdapter(
  options: {
    /** Receives each publication that rejected or timed out. */
    readonly onFailure?: InvalidationPublicationFailureReporter
  } = {}
): InMemoryInvalidationAdapter {
  const subscriptions = new Set<InvalidationSubscription>()
  const published: AxisInvalidation[] = []
  let status: InvalidationStatus = "active"

  return {
    onFailure: options.onFailure ?? (() => undefined),
    get initialStatus() {
      return status
    },
    get published() {
      return Object.freeze([...published])
    },
    subscribe(subscription) {
      subscriptions.add(subscription)
      subscription.onStatusChange(status)
      return () => subscriptions.delete(subscription)
    },
    publish(eventId, stamp) {
      for (const [axis, stampedRevision] of revisionEntries(stamp.revisions)) {
        const invalidation = Object.freeze({
          eventId,
          axis,
          revision: stampedRevision,
        })
        published.push(invalidation)

        for (const subscription of subscriptions) {
          if (!subscription.axes.includes(invalidation.axis)) continue
          subscription.onInvalidation(invalidation)
        }
      }
    },
    setStatus(nextStatus) {
      status = nextStatus
      for (const subscription of subscriptions) {
        subscription.onStatusChange(nextStatus)
      }
    },
  }
}
