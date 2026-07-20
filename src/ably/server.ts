import type { InvalidationPublisher } from "../invalidation"
import { axisId } from "../revisions"
import { ABLY_AXIS_INVALIDATION_EVENT, ablyAxisChannelName } from "./channels"

export interface AblyRestChannel {
  publish(name: string, data: unknown): Promise<unknown>
}

export interface AblyRestClient {
  readonly channels: {
    get(name: string): AblyRestChannel
  }
}

/** Creates the REST publisher used after an authoritative commit. */
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
