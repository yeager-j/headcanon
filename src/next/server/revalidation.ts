import { randomUUID } from "node:crypto"
import { cacheTag, refresh, revalidateTag, updateTag } from "next/cache"

import type {
  InvalidationPublicationFailureReporter,
  InvalidationPublisher,
} from "../../core/invalidation"
import {
  defineCanon,
  revisionEntries,
  type AcceptedStamp,
  type AxisId,
  type Canon,
} from "../../core/revisions"
import { sha256Hex } from "../../core/sha256"

/** Maximum axis count supported by one Next cache-tagged versioned base. */
export const MAX_VERSIONED_BASE_AXES = 128

const AXIS_CACHE_TAG_PREFIX = "headcanon:axis:v1:"
const INVALIDATION_PUBLICATION_TIMEOUT_MS = 1_000

/** Derives the one bounded, versioned cache tag owned by an axis.
 * @param axis Axis address to hash.
 * @returns A promise for the stable cache tag of the axis.
 */
export async function axisCacheTag(axis: AxisId): Promise<string> {
  return `${AXIS_CACHE_TAG_PREFIX}${await sha256Hex(axis)}`
}

/** Parses a `"use cache"` loader's observation into a canon and applies every
 * observed axis tag to its Cache Components entry. It is the cached
 * counterpart of `defineCanon` and runs the same parse.
 * @param input Loader value and raw axis revisions observed together.
 * @returns A promise for the frozen canon, after registering its cache tags.
 * @throws Error when the supplied revision vector is invalid.
 * @throws RangeError when the base exceeds the Next tag limit.
 */
export async function tagVersionedBase<State>(input: {
  readonly value: State
  readonly revisions: Readonly<Record<string, number>>
}): Promise<Canon<State>> {
  const canon = defineCanon(input)
  const axes = revisionEntries(canon.revisions).map(([axis]) => axis)
  if (axes.length > MAX_VERSIONED_BASE_AXES) {
    throw new RangeError(
      `A versioned base may observe at most ${MAX_VERSIONED_BASE_AXES} axes; received ${axes.length}`
    )
  }

  cacheTag(...(await Promise.all(axes.map(axisCacheTag))))
  return canon
}

type ExpireAxis = (tag: string) => void

function recordPublicationFailure(
  reportFailure: InvalidationPublicationFailureReporter,
  failure: Parameters<InvalidationPublicationFailureReporter>[0]
): void {
  try {
    reportFailure(failure)
  } catch {
    // Diagnostics remain advisory just like the publication they observe.
  }
}

async function publishInvalidation(
  stamp: AcceptedStamp,
  invalidations: InvalidationPublisher,
  reportFailure: InvalidationPublicationFailureReporter
): Promise<void> {
  const eventId = randomUUID()
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<"timed-out">((resolve) => {
    timeout = setTimeout(
      () => resolve("timed-out"),
      INVALIDATION_PUBLICATION_TIMEOUT_MS
    )
  })

  try {
    const outcome = await Promise.race([
      Promise.resolve()
        .then(() => invalidations.publish(eventId, stamp))
        .then(() => "published" as const),
      timedOut,
    ])
    if (outcome === "timed-out") {
      recordPublicationFailure(reportFailure, {
        kind: "timed-out",
        eventId,
        stamp,
      })
    }
  } catch (error) {
    recordPublicationFailure(reportFailure, {
      kind: "rejected",
      eventId,
      stamp,
      error,
    })
  } finally {
    clearTimeout(timeout)
  }
}

/** A realtime publisher and the sink for its failures; absent without realtime. */
export interface Publication {
  readonly invalidations: InvalidationPublisher
  readonly reportFailure: InvalidationPublicationFailureReporter
}

export async function finalizeStamp(
  stamp: AcceptedStamp,
  expireAxis: ExpireAxis,
  refreshRoute: (() => void) | undefined,
  publication: Publication | undefined
): Promise<void> {
  for (const [axis] of revisionEntries(stamp.revisions)) {
    expireAxis(await axisCacheTag(axis))
  }

  refreshRoute?.()
  if (publication) {
    await publishInvalidation(
      stamp,
      publication.invalidations,
      publication.reportFailure
    )
  }
}

/** Finalizes a non-protocol commit made inside a Server Action.
 * @param stamp Accepted revisions advanced by the commit.
 * @param invalidations Application-owned invalidation publisher.
 * @param reportFailure Diagnostic sink for publication failures.
 * @returns Completion of cache expiry, route refresh, and bounded publication.
 */
export function finalizeExternalActionCommit(
  stamp: AcceptedStamp,
  invalidations: InvalidationPublisher,
  reportFailure: InvalidationPublicationFailureReporter
): Promise<void> {
  return finalizeStamp(stamp, updateTag, refresh, {
    invalidations,
    reportFailure,
  })
}

/** Finalizes a non-protocol commit without an invoking route to refresh.
 * @param stamp Accepted revisions advanced by the commit.
 * @param invalidations Application-owned invalidation publisher.
 * @param reportFailure Diagnostic sink for publication failures.
 * @returns Completion of cache expiry and bounded publication.
 */
export function announceExternalCommit(
  stamp: AcceptedStamp,
  invalidations: InvalidationPublisher,
  reportFailure: InvalidationPublicationFailureReporter
): Promise<void> {
  return finalizeStamp(
    stamp,
    (tag) => revalidateTag(tag, { expire: 0 }),
    undefined,
    { invalidations, reportFailure }
  )
}
