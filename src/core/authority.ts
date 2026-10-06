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
  acceptedStamp,
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

/**
 * How a command attempt ends without acceptance: a public refusal, recorded
 * and replayed to the caller, or a private denial that is never exposed as a
 * refusal. A failed attempt is also its terminal outcome, so both stages use
 * one vocabulary.
 */
export type MutationAttemptFailure<Refusal> =
  | { readonly kind: "refused"; readonly error: Refusal }
  | { readonly kind: "denied" }

/** A terminal outcome which is safe to record and reproduce on redelivery. */
export type MutationTerminalOutcome<Refusal> =
  | { readonly kind: "accepted"; readonly stamp: AcceptedStamp }
  | MutationAttemptFailure<Refusal>

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
export interface MutationAuthorityRequest<Actor, Refusal = unknown> {
  readonly actor: Actor
  readonly mutationId: string
  readonly protocol: string
  readonly canonical: CanonicalInvocation
  /**
   * Parses a recorded refusal back into the protocol's refusal type. Every
   * refusal crosses the receipt boundary through it, on first execution and
   * on replay. Without it, adapters fail closed: a refusal throws instead of
   * being recorded or replayed unparsed.
   */
  readonly parseRefusal?: (value: unknown) => Refusal
}

/**
 * Owns receipt identity, transaction attempts, savepoint behavior, and retry.
 *
 * The callback may run more than once. An adapter must discard both its
 * transactional effects and its stamp accumulator whenever an attempt rolls
 * back, and must rerun an attempt that throws contention (see
 * {@link isMutationContention}).
 */
export interface MutationAuthorityAdapter<
  Transaction,
  Actor,
  Refusal,
  Preflight,
> {
  /**
   * Executor for fail-closed screening before a receipt is claimed. It reads
   * committed state only: it never observes an in-flight attempt's writes,
   * and reading through it claims no receipt.
   */
  readonly preflight: Preflight
  execute(
    request: MutationAuthorityRequest<Actor, Refusal>,
    run: (
      tx: Transaction,
      stamp: StampAccumulator
    ) => Promise<Result<void, MutationAttemptFailure<Refusal>>>
  ): Promise<
    Result<MutationTerminalOutcome<Refusal>, MutationAuthorityAdapterError>
  >
}

/** Transaction control flow for a guarded write that lost a race. */
export class MutationContentionError extends Error {
  constructor() {
    super("Mutation authority contention")
    this.name = "MutationContentionError"
  }
}

/**
 * Rolls the current attempt back so the authority can retry from current state.
 * @returns Never; throws transaction-control-flow contention.
 * @throws {@link MutationContentionError} to request an authority retry.
 */
export function throwMutationContention(): never {
  throw new MutationContentionError()
}

/**
 * Decides whether a value thrown by an attempt asks the authority to rerun it.
 * A {@link MutationContentionError} always does; an adapter adds the failures
 * its store reports for lost races, such as SQLSTATE codes.
 * @param error The value an attempt threw.
 * @param isStoreContention The adapter's store-specific classification.
 * @returns Whether the attempt lost a race and must rerun from fresh state.
 */
export function isMutationContention(
  error: unknown,
  isStoreContention?: (error: unknown) => boolean
): boolean {
  return (
    error instanceof MutationContentionError ||
    isStoreContention?.(error) === true
  )
}

/** Attempts an authority makes when no `maxAttempts` is configured. */
export const DEFAULT_MUTATION_MAX_ATTEMPTS = 2

/**
 * Builds an adapter's bounded contention retry. The policy is validated once,
 * when the adapter is created.
 * @param options Attempt ceiling and the adapter's store-specific contention classification.
 * @returns A runner that reruns one attempt while it throws contention, and returns `contention` when the ceiling is reached.
 * @throws Error when `maxAttempts` is not a positive integer.
 */
export function contentionRetry(options: {
  readonly maxAttempts?: number
  readonly isStoreContention?: (error: unknown) => boolean
}): <Value>(
  mutationId: string,
  attempt: () => Promise<Result<Value, MutationAuthorityAdapterError>>
) => Promise<Result<Value, MutationAuthorityAdapterError>> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MUTATION_MAX_ATTEMPTS
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("maxAttempts must be a positive integer")
  }

  return async (mutationId, attempt) => {
    for (let attempted = 1; ; attempted += 1) {
      try {
        return await attempt()
      } catch (error) {
        if (!isMutationContention(error, options.isStoreContention)) {
          throw error
        }
        if (attempted >= maxAttempts) {
          return err({ code: "contention", mutationId })
        }
      }
    }
  }
}

/**
 * The receipt identity of one mutation: its ID within a trusted actor scope.
 * Adapters key receipts, and the locks that serialize them, by this value.
 * @param scope Trusted actor scope.
 * @param mutationId Client-generated mutation UUID.
 * @returns A string that differs for every distinct (scope, mutationId) pair.
 */
export function receiptKey(scope: string, mutationId: string): string {
  return JSON.stringify([scope, mutationId])
}

/** One recorded receipt, in the form every adapter stores. */
export interface MutationReceipt {
  readonly protocol: string
  readonly canonicalInvocation: string
  readonly canonicalFingerprint: string
  /** The JSON form produced by {@link recordTerminalOutcome}. */
  readonly terminalOutcome: unknown
}

/**
 * Builds the receipt to store for a request's terminal outcome.
 * @param request The request whose identity the receipt records.
 * @param terminalOutcome The stored JSON form from {@link recordTerminalOutcome}.
 * @returns The receipt fields every adapter stores.
 */
export function mutationReceipt(
  request: MutationAuthorityRequest<unknown, unknown>,
  terminalOutcome: unknown
): MutationReceipt {
  return {
    protocol: request.protocol,
    canonicalInvocation: request.canonical.json,
    canonicalFingerprint: request.canonical.sha256,
    terminalOutcome,
  }
}

/**
 * Decides a redelivery against the receipt recorded under its key: identical
 * canonical identity replays the recorded outcome; anything else is a reused
 * mutation ID.
 * @param receipt The receipt already recorded under the request's receipt key.
 * @param request The redelivered request.
 * @returns The replayed terminal outcome, or `mutation-id-reused`.
 * @throws Error when the recorded outcome is malformed, or holds a refusal that the request cannot parse.
 */
export function replayReceipt<Refusal>(
  receipt: MutationReceipt,
  request: MutationAuthorityRequest<unknown, Refusal>
): Result<MutationTerminalOutcome<Refusal>, MutationAuthorityAdapterError> {
  if (
    receipt.protocol !== request.protocol ||
    receipt.canonicalInvocation !== request.canonical.json ||
    receipt.canonicalFingerprint !== request.canonical.sha256
  ) {
    return err({ code: "mutation-id-reused", mutationId: request.mutationId })
  }
  return ok(parseStoredOutcome(receipt.terminalOutcome, request.parseRefusal))
}

function parseStoredOutcome<Refusal>(
  value: unknown,
  parseRefusal?: (value: unknown) => Refusal
): MutationTerminalOutcome<Refusal> {
  if (!isPlainRecord(value) || typeof value.kind !== "string") {
    throw new Error("Invalid mutation receipt outcome")
  }

  if (value.kind === "accepted") {
    if (!hasExactKeys(value, ["kind", "stamp"])) {
      throw new Error("Invalid accepted mutation receipt")
    }
    const stamp = acceptedStamp(value.stamp)
    if (!stamp.ok) {
      throw new Error(
        `Invalid accepted mutation receipt stamp (${stamp.error.reason})`
      )
    }
    return Object.freeze({ kind: "accepted", stamp: stamp.value })
  }

  if (value.kind === "refused" && hasExactKeys(value, ["kind", "error"])) {
    if (!parseRefusal) {
      throw new Error("Missing mutation receipt refusal parser")
    }
    return Object.freeze({
      kind: "refused",
      error: parseRefusal(structuredClone(value.error)),
    })
  }

  if (value.kind === "denied" && hasExactKeys(value, ["kind"])) {
    return Object.freeze({ kind: "denied" })
  }

  throw new Error("Invalid terminal mutation receipt")
}

/**
 * Turns a finished attempt into its terminal outcome and the JSON form to
 * record. An accepted attempt publishes its stamp; a refused or denied attempt
 * is its own outcome. The outcome comes back through the same parse a replay
 * uses, so the first caller and every redelivery see the same value, and a
 * refusal without a parser fails closed before anything is recorded.
 * @param attempted What the command attempt returned.
 * @param stamp The attempt's accumulator.
 * @param parseRefusal The request's refusal parser.
 * @returns The terminal outcome and its JSON form for the receipt.
 * @throws Error when the outcome is not JSON serializable, or holds a refusal that cannot be parsed.
 */
export function recordTerminalOutcome<Refusal>(
  attempted: Result<void, MutationAttemptFailure<Refusal>>,
  stamp: ReadableStampAccumulator,
  parseRefusal?: (value: unknown) => Refusal
): {
  readonly stored: unknown
  readonly terminal: MutationTerminalOutcome<Refusal>
} {
  const outcome: MutationTerminalOutcome<Refusal> = attempted.ok
    ? { kind: "accepted", stamp: stamp.accepted() }
    : attempted.error
  const json = JSON.stringify(outcome)
  if (json === undefined) {
    throw new Error("Mutation receipt outcome is not JSON serializable")
  }
  const stored: unknown = JSON.parse(json)
  return { stored, terminal: parseStoredOutcome(stored, parseRefusal) }
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
 * denial becomes the terminal receipt outcome. A thrown
 * {@link MutationContentionError} reruns the attempt; contention that outlasts
 * the adapter's attempts is an expected error for the caller to retry.
 *
 * @param options Prepared identity, trusted actor, authority adapter, refusal parser, and application runner.
 * @returns A promise for the terminal outcome or a typed executor/authority failure.
 */
export function executePreparedMutation<
  Transaction,
  Actor,
  Refusal,
  Preflight,
>(options: {
  readonly prepared: PreparedMutationRequest
  readonly actor: Actor
  readonly authority: MutationAuthorityAdapter<
    Transaction,
    Actor,
    Refusal,
    Preflight
  >
  readonly parseRefusal?: (value: unknown) => Refusal
  readonly run: (
    tx: Transaction,
    stamp: StampAccumulator,
    args: unknown
  ) => Promise<Result<void, MutationAttemptFailure<Refusal>>>
}): Promise<Result<MutationTerminalOutcome<Refusal>, MutationExecutorError>> {
  return options.authority.execute(
    {
      actor: options.actor,
      mutationId: options.prepared.mutationId,
      protocol: options.prepared.protocol,
      canonical: options.prepared.canonical,
      parseRefusal: options.parseRefusal,
    },
    (tx, stamp) =>
      options.run(tx, stamp, structuredClone(options.prepared.args))
  )
}
