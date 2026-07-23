import type { InvalidationPublisher } from "../invalidation"
import { axisId } from "../revisions"
import { ABLY_AXIS_INVALIDATION_EVENT, ablyAxisChannelName } from "./channels"

/** Minimal REST channel contract used for accepted-axis publication. */
export interface AblyRestChannel {
  publish(name: string, data: unknown): Promise<unknown>
}

/** Minimal Ably REST client contract used by the publisher. */
export interface AblyRestClient {
  readonly channels: {
    get(name: string): AblyRestChannel
  }
}

/**
 * Creates the REST publisher used after an authoritative commit.
 *
 * Publishing is derived from the accepted stamp: each advanced axis becomes
 * one singleton event containing the caller's event ID, axis, and revision.
 * The publisher does not authorize viewers, persist receipts, or retry failed
 * network calls; those concerns belong to the application/authority boundary
 * and the finalization reporter. Channel names are deployment-scoped and do
 * not expose the raw storage axis.
 *
 * @param options Ably REST client and deployment namespace.
 * @returns An invalidation publisher that emits one message per accepted axis.
 * @throws Rejected publish promises propagate to the caller for reporting.
 */
export function createAblyInvalidationPublisher(options: {
  readonly rest: AblyRestClient
  readonly namespace: string
}): InvalidationPublisher {
  return {
    async publish(eventId, stamp) {
      const entries = await Promise.all(
        Object.entries(stamp.revisions).map(
          async ([rawAxis, stampedRevision]) => {
            const axis = axisId(rawAxis)
            return {
              axis,
              channelName: await ablyAxisChannelName(options.namespace, axis),
              revision: stampedRevision,
            }
          }
        )
      )
      await Promise.all(
        entries.map(({ axis, channelName, revision }) =>
          options.rest.channels
            .get(channelName)
            .publish(ABLY_AXIS_INVALIDATION_EVENT, {
              eventId,
              axis,
              revision,
            })
        )
      )
    },
  }
}
