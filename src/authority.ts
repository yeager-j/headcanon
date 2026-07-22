import type { StandardSchemaV1 } from "@standard-schema/spec"

import { err, ok, type Result } from "@workspace/result"

import {
  prepareCanonicalInvocation,
  type CanonicalInvocation,
  type CanonicalInvocationError,
} from "./canonical-invocation"
import type {
  AnyMutationDefinition,
  MutationInvocation,
  ProtocolDefinition,
} from "./protocol"
import {
  acceptedStamp,
  defineCoordinate,
  revision,
  type AcceptedStamp,
  type AxisId,
  type Revision,
} from "./revisions"

/** The transport envelope admitted by a mutation authority executor. */
export interface MutationEnvelope<Invocation> {
  readonly protocol: string
  readonly mutationId: string
  readonly invocation: Invocation
}

/** The attempt-local authority for constructing a complete accepted vector. */
export interface StampAccumulator {
  record(axis: AxisId, revision: Revision): void
}

export interface ReadableStampAccumulator extends StampAccumulator {
  accepted(): AcceptedStamp
}

/** Creates one isolated revision vector for a single authority attempt. */
export function createStampAccumulator(): ReadableStampAccumulator {
  const revisions = new Map<AxisId, Revision>()

  return {
    record(axis, nextRevision) {
      const parsedRevision = revision(nextRevision)
      if (!parsedRevision.ok) {
        throw new Error(`Invalid stamped revision for axis: ${axis}`)
      }
      const current = revisions.get(axis)
      if (current !== undefined && parsedRevision.value < current) {
        throw new Error(`Revision regressed while stamping axis: ${axis}`)
      }
      revisions.set(axis, parsedRevision.value)
    },
    accepted() {
      // A plain object built through `defineCoordinate` — an accepted stamp
      // rides a Server Action response, so it must survive React's serializer.
      const vector = {} as Record<AxisId, Revision>
      for (const [axis, stampedRevision] of revisions) {
        defineCoordinate(vector, axis, stampedRevision)
      }
      return acceptedStamp(Object.freeze(vector))
    },
  }
}

/** A command attempt either exposes a public refusal or records a private denial. */
export type MutationAttemptFailure<Rejection> =
  | { readonly kind: "refused"; readonly error: Rejection }
  | { readonly kind: "denied" }

/** A terminal outcome which is safe to record and reproduce on redelivery. */
export type MutationTerminalOutcome<Rejection> =
  | { readonly kind: "accepted"; readonly stamp: AcceptedStamp }
  | { readonly kind: "rejected"; readonly error: Rejection }
  | { readonly kind: "denied" }

export type MutationAuthorityAdapterError =
  | { readonly code: "mutation-id-reused"; readonly mutationId: string }
  | { readonly code: "contention"; readonly mutationId: string }

export interface MutationAuthorityRequest<Actor, Rejection = unknown> {
  readonly actor: Actor
  readonly mutationId: string
  readonly protocol: string
  readonly canonical: CanonicalInvocation
  readonly parseRejection?: (value: unknown) => Rejection
}

/**
 * Owns receipt identity, transaction attempts, savepoint behavior, and retry.
 *
 * The callback may run more than once. An adapter must discard both its
 * transactional effects and its stamp accumulator whenever an attempt rolls
 * back.
 */
export interface MutationAuthorityAdapter<
  Transaction,
  Actor,
  Rejection,
  Preflight = Transaction,
> {
  /** Executor used for fail-closed admission before a receipt is claimed. */
  readonly preflight?: Preflight
  execute(
    request: MutationAuthorityRequest<Actor, Rejection>,
    run: (
      tx: Transaction,
      stamp: StampAccumulator
    ) => Promise<Result<void, MutationAttemptFailure<Rejection>>>
  ): Promise<
    Result<MutationTerminalOutcome<Rejection>, MutationAuthorityAdapterError>
  >
}

export type MutationExecutorError =
  | {
      readonly code: "invalid-envelope"
      readonly reason:
        | "not-plain-object"
        | "unexpected-fields"
        | "invalid-protocol"
        | "invalid-mutation-id"
        | "invalid-invocation"
        | "unknown-mutation"
    }
  | {
      readonly code: "invalid-arguments"
      readonly mutation: string
      readonly issues: readonly StandardSchemaV1.Issue[]
    }
  | {
      readonly code: "canonical-invocation"
      readonly error: CanonicalInvocationError
    }
  | MutationAuthorityAdapterError

interface ParsedEnvelope {
  readonly protocol: string
  readonly mutationId: string
  readonly invocation: MutationInvocation<string, unknown>
}

/** A strictly parsed, canonical request which has not touched receipt authority. */
export interface PreparedMutationRequest {
  readonly mutationId: string
  readonly protocol: string
  readonly mutation: string
  readonly args: unknown
  readonly canonical: CanonicalInvocation
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false
  }

  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false

  return Reflect.ownKeys(value).every((key) => {
    if (typeof key === "symbol") return false
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor?.enumerable === true && "value" in descriptor
  })
}

function hasExactly(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  )
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function parseEnvelope(
  value: unknown,
  protocolId: string,
  mutationNames: ReadonlySet<string>
): Result<ParsedEnvelope, MutationExecutorError> {
  if (!isPlainRecord(value)) {
    return err({ code: "invalid-envelope", reason: "not-plain-object" })
  }
  if (!hasExactly(value, ["protocol", "mutationId", "invocation"])) {
    return err({ code: "invalid-envelope", reason: "unexpected-fields" })
  }
  if (value.protocol !== protocolId) {
    return err({ code: "invalid-envelope", reason: "invalid-protocol" })
  }
  if (
    typeof value.mutationId !== "string" ||
    !UUID_PATTERN.test(value.mutationId)
  ) {
    return err({ code: "invalid-envelope", reason: "invalid-mutation-id" })
  }
  if (!isPlainRecord(value.invocation)) {
    return err({ code: "invalid-envelope", reason: "invalid-invocation" })
  }
  if (!hasExactly(value.invocation, ["name", "args"])) {
    return err({ code: "invalid-envelope", reason: "unexpected-fields" })
  }
  if (
    typeof value.invocation.name !== "string" ||
    !mutationNames.has(value.invocation.name)
  ) {
    return err({ code: "invalid-envelope", reason: "unknown-mutation" })
  }

  return ok({
    protocol: protocolId,
    mutationId: value.mutationId,
    invocation: {
      name: value.invocation.name,
      args: value.invocation.args,
    },
  })
}

/** Strictly parses and canonicalizes an envelope without claiming a receipt. */
export async function prepareMutationRequest<
  const Protocol extends ProtocolDefinition<
    string,
    readonly AnyMutationDefinition[]
  >,
>(
  protocol: Protocol,
  envelope: unknown
): Promise<Result<PreparedMutationRequest, MutationExecutorError>> {
  const mutationNames = new Set(
    protocol.mutations.map((mutation) => mutation.name)
  )
  const parsedEnvelope = parseEnvelope(envelope, protocol.id, mutationNames)
  if (!parsedEnvelope.ok) return parsedEnvelope

  const definition =
    protocol.mutationsByName[parsedEnvelope.value.invocation.name]
  if (!definition) {
    return err({ code: "invalid-envelope", reason: "unknown-mutation" })
  }

  const parsedArguments = await definition.args["~standard"].validate(
    parsedEnvelope.value.invocation.args
  )
  if (parsedArguments.issues) {
    return err({
      code: "invalid-arguments",
      mutation: definition.name,
      issues: parsedArguments.issues,
    })
  }

  const invocation = {
    name: definition.name,
    args: parsedArguments.value,
  }
  const prepared = await prepareCanonicalInvocation(protocol.id, invocation)
  if (!prepared.ok) {
    return err({ code: "canonical-invocation", error: prepared.error })
  }

  return ok({
    mutationId: parsedEnvelope.value.mutationId,
    protocol: protocol.id,
    mutation: definition.name,
    args: prepared.value.invocation.args,
    canonical: prepared.value.canonical,
  })
}

/** Executes one prepared request through receipt authority. */
export function executePreparedMutation<
  Transaction,
  Actor,
  Rejection,
  Preflight,
>(options: {
  readonly prepared: PreparedMutationRequest
  readonly actor: Actor
  readonly authority: MutationAuthorityAdapter<
    Transaction,
    Actor,
    Rejection,
    Preflight
  >
  readonly parseRejection?: (value: unknown) => Rejection
  readonly run: (
    tx: Transaction,
    stamp: StampAccumulator,
    args: unknown
  ) => Promise<Result<void, MutationAttemptFailure<Rejection>>>
}): Promise<Result<MutationTerminalOutcome<Rejection>, MutationExecutorError>> {
  return options.authority.execute(
    {
      actor: options.actor,
      mutationId: options.prepared.mutationId,
      protocol: options.prepared.protocol,
      canonical: options.prepared.canonical,
      parseRejection: options.parseRejection,
    },
    (tx, stamp) =>
      options.run(tx, stamp, structuredClone(options.prepared.args))
  )
}
