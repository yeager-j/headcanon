import { randomUUID } from "node:crypto"
import { cacheTag, refresh, revalidateTag, updateTag } from "next/cache"

import type {
  InvalidationPublicationFailure,
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

/** Maximum axis count one cache-tagged canon may observe: Next's tag limit. */
export const MAX_CACHED_CANON_AXES = 128

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
 * @throws RangeError when the canon observes more than {@link MAX_CACHED_CANON_AXES} axes.
 */
export async function defineCachedCanon<State>(input: {
  readonly value: State
  readonly revisions: Readonly<Record<string, number>>
}): Promise<Canon<State>> {
  const canon = defineCanon(input)
  const axes = revisionEntries(canon.revisions).map(([axis]) => axis)
  if (axes.length > MAX_CACHED_CANON_AXES) {
    throw new RangeError(
      `A cached canon may observe at most ${MAX_CACHED_CANON_AXES} axes; received ${axes.length}`
    )
  }

  cacheTag(...(await Promise.all(axes.map(axisCacheTag))))
  return canon
}

type ExpireTag = (tag: string) => void

function recordPublicationFailure(
  invalidations: InvalidationPublisher,
  failure: InvalidationPublicationFailure
): void {
  try {
    if (invalidations.onFailure) invalidations.onFailure(failure)
    else console.error("Headcanon invalidation publication failed:", failure)
  } catch {
    // Diagnostics remain advisory just like the publication they observe.
  }
}

/**
 * Waits for `work` to settle, or for `ms` to pass. A throw or rejection from
 * `work` propagates.
 */
async function settleWithin(
  work: () => unknown,
  ms: number
): Promise<"settled" | "timed-out"> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<"timed-out">((resolve) => {
    timeout = setTimeout(() => resolve("timed-out"), ms)
  })

  try {
    return await Promise.race([
      Promise.resolve()
        .then(work)
        .then(() => "settled" as const),
      timedOut,
    ])
  } finally {
    clearTimeout(timeout)
  }
}

async function publishInvalidation(
  stamp: AcceptedStamp,
  invalidations: InvalidationPublisher
): Promise<void> {
  const eventId = randomUUID()
  try {
    const outcome = await settleWithin(
      () => invalidations.publish(eventId, stamp),
      INVALIDATION_PUBLICATION_TIMEOUT_MS
    )
    if (outcome === "timed-out") {
      recordPublicationFailure(invalidations, {
        kind: "timed-out",
        eventId,
        stamp,
      })
    }
  } catch (error) {
    recordPublicationFailure(invalidations, {
      kind: "rejected",
      eventId,
      stamp,
      error,
    })
  }
}

export async function finalizeStamp(
  stamp: AcceptedStamp,
  expireTag: ExpireTag,
  refreshRoute: (() => void) | undefined,
  invalidations: InvalidationPublisher | undefined
): Promise<void> {
  for (const [axis] of revisionEntries(stamp.revisions)) {
    expireTag(await axisCacheTag(axis))
  }

  refreshRoute?.()
  if (invalidations) await publishInvalidation(stamp, invalidations)
}

/**
 * Finalizes a non-protocol commit from inside a Server Action: expires its
 * axis tags, refreshes the invoking route, then publishes.
 * @param stamp Accepted revisions advanced by the commit.
 * @param invalidations Application-owned invalidation publisher; omit it when the application has no realtime transport.
 * @returns Completion of cache expiry, route refresh, and bounded publication.
 */
export function finalizeExternalActionCommit(
  stamp: AcceptedStamp,
  invalidations?: InvalidationPublisher
): Promise<void> {
  return finalizeStamp(stamp, updateTag, refresh, invalidations)
}

/**
 * Finalizes a non-protocol commit outside a Server Action (Route Handler,
 * webhook, job): expires its axis tags at once, then publishes. It refreshes
 * no route.
 * @param stamp Accepted revisions advanced by the commit.
 * @param invalidations Application-owned invalidation publisher; omit it when the application has no realtime transport.
 * @returns Completion of cache expiry and bounded publication.
 */
export function announceExternalCommit(
  stamp: AcceptedStamp,
  invalidations?: InvalidationPublisher
): Promise<void> {
  return finalizeStamp(
    stamp,
    (tag) => revalidateTag(tag, { expire: 0 }),
    undefined,
    invalidations
  )
}
