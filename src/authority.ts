import type { StandardSchemaV1 } from "@standard-schema/spec"
import { err, ok, type Result } from "serializable-result"

import { hasExactKeys, isPlainRecord } from "./admission"
import {
  canonicalInvocation,
  canonicalJson,
  type CanonicalInvocation,
  type CanonicalInvocationError,
} from "./canonical-invocation"
import {
  findMutation,
  type AnyMutationDefinition,
  type ProtocolDefinition,
} from "./protocol"
import {
  revision,
  revisionVectorFrom,
  stampRecordedRevisions,
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
  /** Validates and records one persisted revision for this authority attempt. */
  record(axis: AxisId, revision: number): void
}

/** A stamp accumulator that can publish the complete vector for its attempt. */
export interface ReadableStampAccumulator extends StampAccumulator {
  accepted(): AcceptedStamp
}

/**
 * Creates one isolated revision vector for a single authority attempt.
 *
 * Commands call `record` once for every persisted revision they advance. The
 * accumulator rejects invalid or regressing coordinates and `accepted()`
 * returns the complete vector for the attempt. The authority must discard it
 * when a transaction rolls back; it is deliberately not a process-wide
 * revision store.
 *
 * @returns A fresh accumulator whose accepted stamp contains only this attempt's records.
 */
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
      return stampRecordedRevisions(revisionVectorFrom(revisions))
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

declare const protocolIdentity: unique symbol

/**
 * Phantom protocol identity for a generated executor's outcome. A generated
 * Server Action admits `unknown` envelopes, so its parameter carries no
 * protocol evidence, and an app wrapper preserves only the return type —
 * without this tag, two protocols with compatible refusal unions would let a
 * client bind the wrong generated action and only fail at runtime. The
 * property is optional and never present at runtime; it exists purely so
 * structural assignability compares protocol ids.
 */
export type ProtocolIdentity<ProtocolId extends string> = {
  readonly [protocolIdentity]?: ProtocolId
}

/** Expected authority failures that prevent a terminal receipt outcome. */
export type MutationAuthorityAdapterError =
  | { readonly code: "mutation-id-reused"; readonly mutationId: string }
  | { readonly code: "contention"; readonly mutationId: string }

/** Trusted context and canonical identity supplied to a mutation authority adapter. */
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

/** Failures returned before or while admitting a mutation into authority execution. */
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
  readonly mutationId: string
  readonly definition: AnyMutationDefinition
  readonly args: unknown
}

/** A strictly parsed, canonical request which has not touched receipt authority. */
export interface PreparedMutationRequest {
  readonly mutationId: string
  readonly protocol: string
  readonly mutation: string
  readonly args: unknown
  readonly canonical: CanonicalInvocation
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function parseEnvelope(
  value: unknown,
  protocol: ProtocolDefinition<string, readonly AnyMutationDefinition[]>
): Result<ParsedEnvelope, MutationExecutorError> {
  if (!isPlainRecord(value)) {
    return err({ code: "invalid-envelope", reason: "not-plain-object" })
  }
  if (!hasExactKeys(value, ["protocol", "mutationId", "invocation"])) {
    return err({ code: "invalid-envelope", reason: "unexpected-fields" })
  }
  if (value.protocol !== protocol.id) {
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
  if (!hasExactKeys(value.invocation, ["name", "args"])) {
    return err({ code: "invalid-envelope", reason: "unexpected-fields" })
  }
  const definition = findMutation(protocol, value.invocation.name)
  if (!definition) {
    return err({ code: "invalid-envelope", reason: "unknown-mutation" })
  }

  return ok({
    mutationId: value.mutationId,
    definition,
    args: value.invocation.args,
  })
}

/** Reported when a schema changes arguments that should already be parsed. */
const UNPARSED_ARGUMENTS_ISSUE: StandardSchemaV1.Issue = Object.freeze({
  message:
    "Arguments must arrive in parsed form: the mutation's argument schema changed them",
})

/**
 * Strictly parses and canonicalizes an envelope without claiming a receipt.
 *
 * This is the server-side trust-boundary step: it checks the exact envelope
 * shape and protocol, validates the mutation name, parses arguments with the
 * registered Standard Schema, and derives canonical receipt identity. Clients
 * send arguments in parsed form (the value they predicted with), so arguments
 * the schema changes are refused as `invalid-arguments`; otherwise the
 * predictor and the command would run on different values. It does not call
 * application commands, open a transaction, or reserve mutation identity, so
 * invalid requests cannot create receipt rows.
 *
 * @param protocol Protocol whose ID, registry, and argument schemas admit the request.
 * @param envelope Untrusted value received from a transport boundary.
 * @returns A prepared request or a typed admission/canonicalization failure.
 */
export async function prepareMutationRequest<
  const Protocol extends ProtocolDefinition<
    string,
    readonly AnyMutationDefinition[]
  >,
>(
  protocol: Protocol,
  envelope: unknown
): Promise<Result<PreparedMutationRequest, MutationExecutorError>> {
  const parsedEnvelope = parseEnvelope(envelope, protocol)
  if (!parsedEnvelope.ok) return parsedEnvelope

  const { definition, args } = parsedEnvelope.value
  const parsedArguments = await definition.args["~standard"].validate(args)
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
  const prepared = await canonicalInvocation(protocol.id, invocation)
  if (!prepared.ok) {
    return err({ code: "canonical-invocation", error: prepared.error })
  }

  const received = canonicalJson(args)
  const parsed = canonicalJson(parsedArguments.value)
  if (!received.ok || !parsed.ok || received.value !== parsed.value) {
    return err({
      code: "invalid-arguments",
      mutation: definition.name,
      issues: [UNPARSED_ARGUMENTS_ISSUE],
    })
  }

  return ok({
    mutationId: parsedEnvelope.value.mutationId,
    protocol: protocol.id,
    mutation: definition.name,
    args: prepared.value.invocation.args,
    canonical: prepared.value.canonical,
  })
}

/**
 * Executes one prepared request through receipt authority.
 *
 * The adapter owns receipt deduplication, collision detection, transaction
 * attempts, and contention retry. The `run` callback owns application policy
 * and writes for the current attempt; it may be invoked more than once, so it
 * must be safe to rerun against fresh transaction state. A returned refusal or
 * denial becomes a terminal receipt outcome, while adapter contention remains
 * an expected error for the caller to retry.
 *
 * @param options Prepared identity, trusted actor, authority adapter, refusal parser, and application runner.
 * @returns A promise for the terminal outcome or a typed executor/authority failure.
 */
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
