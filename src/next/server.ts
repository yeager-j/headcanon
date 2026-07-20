import { createHash, randomUUID } from "node:crypto"
import { cacheTag, refresh, revalidateTag, updateTag } from "next/cache"

import {
  createMutationExecutor,
  type MutationAuthorityAdapter,
  type MutationHandlers,
} from "../authority"
import type { InvalidationPublisher } from "../invalidation"
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

async function publishInvalidation(
  stamp: AcceptedStamp,
  invalidations: InvalidationPublisher
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<void>((resolve) => {
    timeout = setTimeout(resolve, INVALIDATION_PUBLICATION_TIMEOUT_MS)
  })

  try {
    await Promise.race([
      Promise.resolve().then(() => invalidations.publish(randomUUID(), stamp)),
      timedOut,
    ])
  } catch {
    // Realtime publication is advisory; cache expiry remains authoritative.
  } finally {
    clearTimeout(timeout)
  }
}

async function finalizeStamp(
  stamp: AcceptedStamp,
  invalidations: InvalidationPublisher,
  expireAxis: ExpireAxis,
  refreshRoute?: () => void
): Promise<void> {
  for (const rawAxis of Object.keys(stamp.revisions)) {
    expireAxis(axisCacheTag(axisId(rawAxis)))
  }

  refreshRoute?.()
  await publishInvalidation(stamp, invalidations)
}

/** Finalizes a non-protocol commit made inside a Server Action. */
export function finalizeExternalActionCommit(
  stamp: AcceptedStamp,
  invalidations: InvalidationPublisher
): Promise<void> {
  return finalizeStamp(stamp, invalidations, updateTag, refresh)
}

/** Finalizes a non-protocol commit without an invoking route to refresh. */
export function announceExternalCommit(
  stamp: AcceptedStamp,
  invalidations: InvalidationPublisher
): Promise<void> {
  return finalizeStamp(stamp, invalidations, (tag) =>
    revalidateTag(tag, { expire: 0 })
  )
}

/** Adds Next Server Action finalization to the framework-independent executor. */
export function createNextMutationExecutor<
  const Protocol extends ProtocolDefinition<
    string,
    readonly AnyMutationDefinition[]
  >,
  Transaction,
  Actor,
  Rejection,
>(options: {
  readonly protocol: Protocol
  readonly authority: MutationAuthorityAdapter<Transaction, Actor, Rejection>
  readonly handlers: MutationHandlers<Protocol, Transaction, Actor, Rejection>
  readonly invalidations: InvalidationPublisher
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
      options.invalidations
    )
    return outcome
  }
}
