import type {
  AxisInvalidation,
  InvalidationAdapter,
  InvalidationPublisher,
  InvalidationStatus,
  InvalidationSubscription,
} from "../core/invalidation"
import { revisionEntries } from "../core/revisions"

/** Synchronous in-memory invalidation bus for contract tests and fixtures. */
export interface InMemoryInvalidationAdapter
  extends InvalidationAdapter, InvalidationPublisher {
  readonly published: readonly AxisInvalidation[]
  setStatus(status: InvalidationStatus): void
}

/**
 * A synchronous per-axis invalidation bus for tests and local fixtures. It has
 * no test-framework dependency.
 * @returns An in-memory invalidation adapter and publisher.
 */
export function createInMemoryInvalidationAdapter(): InMemoryInvalidationAdapter {
  const subscriptions = new Set<InvalidationSubscription>()
  const published: AxisInvalidation[] = []
  let status: InvalidationStatus = "active"

  return {
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
