import type { InvalidationPublisher } from "../core/invalidation"
import { revisionEntries, type AxisId, type Revision } from "../core/revisions"
import {
  ABLY_AXIS_INVALIDATION_EVENT,
  ablyAxisChannelName,
  ablyChannelNamespace,
} from "./channels"

/** One REST batch-publish request entry: these messages to these channels. */
export interface AblyBatchPublishSpec {
  readonly channels: string[]
  readonly messages: { readonly name: string; readonly data: unknown }[]
}

/** Ably's outcome for one spec; a per-channel `error` marks that channel failed. */
export interface AblyBatchPublishResult {
  readonly results: readonly {
    readonly channel: string
    readonly error?: unknown
  }[]
}

/** Minimal Ably REST client contract used by the publisher. */
export interface AblyRestClient {
  /**
   * Publishes each spec. Resolves with one result per spec, in the order of
   * `specs`; a missing result counts as a failure for that channel.
   */
  batchPublish(specs: AblyBatchPublishSpec[]): Promise<AblyBatchPublishResult[]>
}

/** One stamped axis whose invalidation Ably did not accept. */
export interface AblyAxisPublicationFailure {
  readonly axis: AxisId
  readonly channel: string
  readonly error: unknown
}

/**
 * Rejection reason of an Ably publication that failed for some or all axes.
 * Axes not listed in `failures` were accepted by Ably.
 */
export class AblyInvalidationPublicationError extends Error {
  /** Every stamped axis Ably did not accept, with Ably's reason. */
  readonly failures: readonly AblyAxisPublicationFailure[]
  /** Number of stamped axes the publication attempted. */
  readonly attempted: number

  /**
   * @param failures Axes Ably did not accept.
   * @param attempted Number of stamped axes in the publication.
   */
  constructor(
    failures: readonly AblyAxisPublicationFailure[],
    attempted: number
  ) {
    super(
      `Ably did not publish invalidations for ${failures.length} of ${attempted} axes: ${failures
        .map(({ axis }) => axis)
        .join(", ")}`
    )
    this.name = "AblyInvalidationPublicationError"
    this.failures = failures
    this.attempted = attempted
  }
}

/** Ably accepts at most this many channels in one batch-publish request. */
const MAX_BATCH_CHANNELS = 100

interface AxisPublication {
  readonly axis: AxisId
  readonly channel: string
  readonly revision: Revision
}

function inBatches<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = []
  for (let start = 0; start < items.length; start += size) {
    batches.push(items.slice(start, start + size))
  }
  return batches
}

function invalidationSpec(
  eventId: string,
  { axis, channel, revision }: AxisPublication
): AblyBatchPublishSpec {
  return {
    channels: [channel],
    messages: [
      { name: ABLY_AXIS_INVALIDATION_EVENT, data: { eventId, axis, revision } },
    ],
  }
}

function batchFailures(
  batch: readonly AxisPublication[],
  outcome: PromiseSettledResult<AblyBatchPublishResult[]>
): AblyAxisPublicationFailure[] {
  if (outcome.status === "rejected") {
    return batch.map(({ axis, channel }) => ({
      axis,
      channel,
      error: outcome.reason,
    }))
  }
  return batch.flatMap(({ axis, channel }, index) => {
    const specResult = outcome.value[index]
    if (!specResult) {
      const error = new Error("Ably returned no result for this channel")
      return [{ axis, channel, error }]
    }
    const refused = specResult.results.find(
      (channelResult) => channelResult.error !== undefined
    )
    return refused ? [{ axis, channel, error: refused.error }] : []
  })
}

/**
 * Creates the REST publisher used after an authoritative commit.
 *
 * Publishing is derived from the accepted stamp: each advanced axis becomes
 * one singleton event on its axis channel, carrying the caller's event ID,
 * the axis, and its revision. All axes go out through Ably batch publish, at
 * most 100 channels per request, with requests sent in parallel.
 *
 * Every request runs to completion. If Ably rejects a request or reports an
 * error for a channel, the returned promise rejects with
 * {@link AblyInvalidationPublicationError} listing exactly the axes that were
 * not published; the others were. The publisher does not authorize viewers,
 * persist receipts, or retry; those concerns belong to the application or
 * authority boundary and the finalization failure reporter.
 *
 * @param options Ably REST client and deployment namespace.
 * @returns An invalidation publisher for accepted stamps.
 * @throws Error at construction when `namespace` is invalid (see `ablyChannelNamespace`).
 */
export function createAblyInvalidationPublisher(options: {
  readonly rest: AblyRestClient
  readonly namespace: string
}): InvalidationPublisher {
  const namespace = ablyChannelNamespace(options.namespace)

  return {
    async publish(eventId, stamp) {
      const publications: AxisPublication[] = await Promise.all(
        revisionEntries(stamp.revisions).map(async ([axis, revision]) => ({
          axis,
          channel: await ablyAxisChannelName(namespace, axis),
          revision,
        }))
      )
      const batches = inBatches(publications, MAX_BATCH_CHANNELS)

      const outcomes = await Promise.allSettled(
        batches.map((batch) =>
          options.rest.batchPublish(
            batch.map((publication) => invalidationSpec(eventId, publication))
          )
        )
      )
      const failures = outcomes.flatMap((outcome, index) =>
        batchFailures(batches[index] ?? [], outcome)
      )

      if (failures.length > 0) {
        throw new AblyInvalidationPublicationError(
          failures,
          publications.length
        )
      }
    },
  }
}
