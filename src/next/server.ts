import { createHash, randomUUID } from "node:crypto"
import { cacheTag, refresh, revalidateTag, updateTag } from "next/cache"

import {
  createMutationExecutor,
  type MutationAuthorityAdapter,
  type MutationHandlers,
} from "../authority"
import type {
  InvalidationPublicationFailureReporter,
  InvalidationPublisher,
} from "../invalidation"
import type { AnyMutationDefinition, ProtocolDefinition } from "../protocol"
import {
  axisId,
  type AcceptedStamp,
  type AxisId,
  type RevisionVector,
} from "../revisions"

export const MAX_VERSIONED_BASE_AXES = 128

const AXIS_CACHE_TAG_PREFIX = "headcanon:axis:v1:"
const INVALIDATION_PUBLICATION_TIMEOUT_MS = 1_000

/** Derives the one bounded, versioned cache tag owned by an axis. */
export function axisCacheTag(axis: AxisId): string {
  const digest = createHash("sha256").update(axis, "utf8").digest("hex")
  return `${AXIS_CACHE_TAG_PREFIX}${digest}`
}

/** Applies every observed axis tag to one Cache Components entry. */
export function tagVersionedBase<
  Base extends { readonly revisions: RevisionVector },
>(base: Base): Base {
  const axes = Object.keys(base.revisions).map(axisId)
  if (axes.length > MAX_VERSIONED_BASE_AXES) {
    throw new RangeError(
      `A versioned base may observe at most ${MAX_VERSIONED_BASE_AXES} axes; received ${axes.length}`
    )
  }

  cacheTag(...axes.map(axisCacheTag))
  return base
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

async function finalizeStamp(
  stamp: AcceptedStamp,
  invalidations: InvalidationPublisher,
  expireAxis: ExpireAxis,
  reportFailure: InvalidationPublicationFailureReporter,
  refreshRoute?: () => void
): Promise<void> {
  for (const rawAxis of Object.keys(stamp.revisions)) {
    expireAxis(axisCacheTag(axisId(rawAxis)))
  }

  refreshRoute?.()
  await publishInvalidation(stamp, invalidations, reportFailure)
}

/** Finalizes a non-protocol commit made inside a Server Action. */
export function finalizeExternalActionCommit(
  stamp: AcceptedStamp,
  invalidations: InvalidationPublisher,
  reportFailure: InvalidationPublicationFailureReporter
): Promise<void> {
  return finalizeStamp(stamp, invalidations, updateTag, reportFailure, refresh)
}

/** Finalizes a non-protocol commit without an invoking route to refresh. */
export function announceExternalCommit(
  stamp: AcceptedStamp,
  invalidations: InvalidationPublisher,
  reportFailure: InvalidationPublicationFailureReporter
): Promise<void> {
  return finalizeStamp(
    stamp,
    invalidations,
    (tag) => revalidateTag(tag, { expire: 0 }),
    reportFailure
  )
}

/** Adds Next Server Action finalization to the framework-independent executor. */
export function createNextMutationExecutor<
  const Protocol extends ProtocolDefinition<
    string,
    readonly AnyMutationDefinition[],
    unknown
  >,
  Transaction,
  Actor,
  Rejection,
>(options: {
  readonly protocol: Protocol
  readonly authority: MutationAuthorityAdapter<Transaction, Actor, Rejection>
  readonly handlers: MutationHandlers<Protocol, Transaction, Actor, Rejection>
  readonly invalidations: InvalidationPublisher
  readonly reportInvalidationFailure: InvalidationPublicationFailureReporter
}) {
  const execute = createMutationExecutor({
    protocol: options.protocol,
    authority: options.authority,
    handlers: options.handlers,
  })

  return async (envelope: unknown, actor: Actor) => {
    const outcome = await execute(envelope, actor)
    if (!outcome.ok || outcome.value.kind !== "accepted") return outcome

    await finalizeExternalActionCommit(
      outcome.value.stamp,
      options.invalidations,
      options.reportInvalidationFailure
    )
    return outcome
  }
}
