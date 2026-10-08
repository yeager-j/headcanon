import type { StandardSchemaV1 } from "@standard-schema/spec"
import { err, ok, type Result } from "serializable-result"

import { hasExactKeys, isPlainRecord } from "./admission"
import {
  canonicalJson,
  prepareCanonicalInvocation,
  type CanonicalInvocation,
  type CanonicalInvocationError,
} from "./canonical-invocation"
import {
  findMutation,
  type AnyMutationDefinition,
  type AnyProtocolDefinition,
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
  /**
   * When the client created the mutation, in epoch milliseconds on the
   * client's clock. Every redelivery of the mutation keeps it. The authority
   * refuses a new execution outside its delivery window.
   */
  readonly createdAt: number
  readonly invocation: Invocation
}

/** The attempt-local authority for constructing a complete accepted vector. */
export interface StampAccumulator {
  /**
   * Records one persisted revision for this authority attempt. Recording the
   * same revision again is allowed.
   * @throws Error when `revision` is not a non-negative safe integer, or is lower than a revision already recorded for `axis` in this attempt.
   */
  record(axis: AxisId, revision: number): void
}

/** A stamp accumulator that also returns the accepted stamp for its attempt. */
export interface ReadableStampAccumulator extends StampAccumulator {
  /** Returns a frozen stamp that holds every revision recorded so far in this attempt. */
  accepted(): AcceptedStamp
}

/**
 * Creates one isolated revision vector for a single authority attempt. A
 * custom {@link MutationAuthorityAdapter} uses it to mint the accepted stamp
 * for each attempt.
 *
 * Commands call `record` once for every persisted revision they advance. The
 * accumulator rejects invalid or regressing coordinates and `accepted()`
 * returns the complete vector for the attempt. The authority must discard it
 * when a transaction rolls back.
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
 * refusal.
 */
export type MutationAttemptFailure<Refusal> =
  | { readonly kind: "refused"; readonly error: Refusal }
  | { readonly kind: "denied" }

/** A terminal outcome which is safe to record and reproduce on redelivery. */
export type MutationTerminalOutcome<Refusal> =
  | { readonly kind: "accepted"; readonly stamp: AcceptedStamp }
  | MutationAttemptFailure<Refusal>

/** The JSON form of a {@link MutationTerminalOutcome}, as an adapter stores it in a receipt. */
export type StoredTerminalOutcome =
  | {
      readonly kind: "accepted"
      readonly stamp: { readonly revisions: unknown }
    }
  | { readonly kind: "refused"; readonly error: unknown }
  | { readonly kind: "denied" }

declare const protocolIdentity: unique symbol

/**
 * Phantom type tag that makes outcomes of different protocols unassignable to
 * each other, even when their refusal types match. A wrapper that returns a
 * tagged outcome must keep the tag in its return type. The property is
 * optional and never present at runtime.
 */
export type ProtocolIdentity<ProtocolId extends string> = {
  readonly [protocolIdentity]?: ProtocolId
}

/**
 * The authority refused a new execution because the envelope's `createdAt`
 * is outside its delivery window: older than the maximum delivery age, or
 * further ahead of the authority's clock than its skew tolerance. Nothing
 * was recorded.
 */
export type MutationDeliveryAgeError =
  | { readonly code: "delivery-expired"; readonly mutationId: string }
  | { readonly code: "delivery-from-future"; readonly mutationId: string }

/** Expected authority failures that prevent a terminal receipt outcome. */
export type MutationAuthorityAdapterError =
  | { readonly code: "mutation-id-reused"; readonly mutationId: string }
  | { readonly code: "contention"; readonly mutationId: string }
  | MutationDeliveryAgeError

/** Trusted context and canonical identity supplied to a mutation authority adapter. */
export interface MutationAuthorityRequest<Actor, Refusal = unknown> {
  readonly actor: Actor
  readonly mutationId: string
  /** The envelope's `createdAt`: client epoch milliseconds. */
  readonly createdAt: number
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
 * back, and must rerun an attempt that throws {@link MutationContentionError},
 * or a store error that signals a lost race.
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
  /**
   * Runs one request under its receipt key: the actor's scope and the
   * mutation ID. Calls with one key run one at a time; calls with different
   * keys may interleave.
   *
   * If a receipt is already recorded under the key, returns its outcome when
   * the request's canonical identity matches, or `mutation-id-reused` when it
   * does not, whatever the request's `createdAt`. Otherwise, before every
   * attempt, reads the adapter's clock and checks the request with
   * {@link checkDeliveryAge}; a refusal returns at once, without calling `run`
   * and without recording a receipt. Each admitted attempt calls `run` with a
   * fresh transaction and a fresh {@link createStampAccumulator} accumulator.
   * The adapter records the terminal outcome, timestamped with the clock
   * reading that admitted the attempt, and returns it. Returns `contention`
   * when every attempt the adapter allows ends in contention.
   *
   * Receipt cleanup must read the same clock: a receipt may be deleted only
   * once {@link receiptRetentionMs} has passed since that timestamp.
   * @throws What `run` throws, other than contention; and an Error when a refusal must be recorded or replayed and the request has no `parseRefusal`.
   */
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
 * Call it from a command when a guarded write loses a race.
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

/** Maximum delivery age an authority uses when none is configured: 7 days. */
export const DEFAULT_MAX_DELIVERY_AGE_MS = 604_800_000

/** Clock skew tolerance an authority uses when none is configured: 1 hour. */
export const DEFAULT_CLOCK_SKEW_TOLERANCE_MS = 3_600_000

/** Extra receipt retention that cleanup adds when none is given: 1 hour. */
export const DEFAULT_RECEIPT_CLEANUP_MARGIN_MS = 3_600_000

/**
 * The delivery window of one authority. A new execution is admitted only
 * when the envelope's `createdAt` is no older than `maxDeliveryAgeMs` and no
 * further ahead than `clockSkewToleranceMs` on the authority's clock. Keep
 * both values fixed for a receipt table once receipt cleanup runs.
 */
export interface DeliveryAgePolicy {
  readonly maxDeliveryAgeMs: number
  readonly clockSkewToleranceMs: number
}

/**
 * Builds an adapter's delivery window. The window is validated once, when the
 * adapter is created.
 * @param options The maximum age and skew tolerance in milliseconds; each defaults when omitted.
 * @returns A frozen policy.
 * @throws Error when `maxDeliveryAgeMs` is not a positive safe integer, or `clockSkewToleranceMs` is not a non-negative safe integer.
 */
export function deliveryAgePolicy(options: {
  readonly maxDeliveryAgeMs?: number
  readonly clockSkewToleranceMs?: number
}): DeliveryAgePolicy {
  const maxDeliveryAgeMs =
    options.maxDeliveryAgeMs ?? DEFAULT_MAX_DELIVERY_AGE_MS
  const clockSkewToleranceMs =
    options.clockSkewToleranceMs ?? DEFAULT_CLOCK_SKEW_TOLERANCE_MS

  if (!Number.isSafeInteger(maxDeliveryAgeMs) || maxDeliveryAgeMs < 1) {
    throw new Error("maxDeliveryAgeMs must be a positive safe integer")
  }

  if (!isNonNegativeSafeInteger(clockSkewToleranceMs)) {
    throw new Error("clockSkewToleranceMs must be a non-negative safe integer")
  }

  return Object.freeze({ maxDeliveryAgeMs, clockSkewToleranceMs })
}

/**
 * Decides whether a request with no recorded receipt may execute now.
 * @param policy The adapter's delivery window.
 * @param request The request's mutation ID and `createdAt`.
 * @param now The adapter's clock, in epoch milliseconds.
 * @returns Nothing when `createdAt` is within the window; otherwise `delivery-expired` or `delivery-from-future`.
 */
export function checkDeliveryAge(
  policy: DeliveryAgePolicy,
  request: { readonly mutationId: string; readonly createdAt: number },
  now: number
): Result<void, MutationDeliveryAgeError> {
  const { mutationId, createdAt } = request

  if (createdAt < now - policy.maxDeliveryAgeMs) {
    return err({ code: "delivery-expired", mutationId })
  }

  if (createdAt > now + policy.clockSkewToleranceMs) {
    return err({ code: "delivery-from-future", mutationId })
  }

  return ok(undefined)
}

/**
 * How long a receipt must stay recorded before cleanup may delete it: after
 * this time, no redelivery with the envelope's original `createdAt` can pass
 * {@link checkDeliveryAge}. Measure it from the receipt's timestamp on the
 * same clock that checked the delivery.
 * @param policy The delivery window every server sharing the receipt table uses.
 * @param marginMs Extra retention for clock adjustments.
 * @returns `maxDeliveryAgeMs + clockSkewToleranceMs + marginMs`.
 * @throws Error when `marginMs` is not a non-negative safe integer, or the sum is not a safe integer.
 */
export function receiptRetentionMs(
  policy: DeliveryAgePolicy,
  marginMs: number
): number {
  if (!isNonNegativeSafeInteger(marginMs)) {
    throw new Error("marginMs must be a non-negative safe integer")
  }

  const retentionMs =
    policy.maxDeliveryAgeMs + policy.clockSkewToleranceMs + marginMs
  if (!Number.isSafeInteger(retentionMs)) {
    throw new Error("Receipt retention must be a safe integer")
  }

  return retentionMs
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
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
export interface StoredReceipt {
  readonly protocol: string
  readonly canonicalInvocation: string
  readonly canonicalFingerprint: string
  /** The JSON form produced by {@link prepareTerminalOutcome}. */
  readonly terminalOutcome: StoredTerminalOutcome
}

/**
 * Builds the receipt to store for a request's terminal outcome.
 * @param request The request whose identity the receipt records.
 * @param terminalOutcome The stored JSON form from {@link prepareTerminalOutcome}.
 * @returns The receipt fields every adapter stores.
 */
export function storedReceipt(
  request: MutationAuthorityRequest<unknown, unknown>,
  terminalOutcome: StoredTerminalOutcome
): StoredReceipt {
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
  receipt: StoredReceipt,
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
    const parsedStamp = acceptedStamp(value.stamp)
    if (!parsedStamp.ok) {
      throw new Error(
        `Invalid accepted mutation receipt stamp (${parsedStamp.error.reason})`
      )
    }
    return Object.freeze({ kind: "accepted", stamp: parsedStamp.value })
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
export function prepareTerminalOutcome<Refusal>(
  attempted: Result<void, MutationAttemptFailure<Refusal>>,
  stamp: ReadableStampAccumulator,
  parseRefusal?: (value: unknown) => Refusal
): {
  readonly stored: StoredTerminalOutcome
  readonly terminal: MutationTerminalOutcome<Refusal>
} {
  const outcome: MutationTerminalOutcome<Refusal> = attempted.ok
    ? { kind: "accepted", stamp: stamp.accepted() }
    : attempted.error
  const json = JSON.stringify(outcome)
  if (json === undefined) {
    throw new Error("Mutation receipt outcome is not JSON serializable")
  }
  const stored: StoredTerminalOutcome = JSON.parse(json)
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
        | "invalid-created-at"
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

/** An envelope that passed {@link parseEnvelope}. */
export interface ParsedEnvelope {
  readonly mutationId: string
  readonly createdAt: number
  readonly definition: AnyMutationDefinition
  readonly args: unknown
}

/** A strictly parsed, canonical request which has not touched receipt authority. */
export interface PreparedMutationRequest {
  readonly mutationId: string
  /** The envelope's `createdAt`: client epoch milliseconds. */
  readonly createdAt: number
  readonly protocol: string
  readonly mutation: string
  readonly args: unknown
  readonly canonical: CanonicalInvocation
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Checks an untrusted envelope's exact shape against `protocol`. Not a package
 * export: the authority admits deliveries with it, and a predicted root checks
 * a stored queue with it.
 */
export function parseEnvelope(
  value: unknown,
  protocol: AnyProtocolDefinition
): Result<ParsedEnvelope, MutationExecutorError> {
  if (!isPlainRecord(value)) {
    return err({ code: "invalid-envelope", reason: "not-plain-object" })
  }
  if (
    !hasExactKeys(value, ["protocol", "mutationId", "createdAt", "invocation"])
  ) {
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
  if (
    typeof value.createdAt !== "number" ||
    !isNonNegativeSafeInteger(value.createdAt)
  ) {
    return err({ code: "invalid-envelope", reason: "invalid-created-at" })
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
    createdAt: value.createdAt,
    definition,
    args: value.invocation.args,
  })
}

/**
 * Arguments are in parsed form when their schema's output has the same
 * canonical JSON as the arguments themselves. Not a package export: the
 * authority admits arguments with it, and a predicted root checks a stored
 * queue with it.
 * @param received Arguments as they arrived.
 * @param parsed The argument schema's output for `received`.
 */
export function isParsedForm(received: unknown, parsed: unknown): boolean {
  const receivedJson = canonicalJson(received)
  const parsedJson = canonicalJson(parsed)

  return (
    receivedJson.ok && parsedJson.ok && receivedJson.value === parsedJson.value
  )
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
 * shape (including a non-negative integer `createdAt`) and protocol, validates the mutation name, parses arguments with the
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
  const Protocol extends AnyProtocolDefinition,
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
  const prepared = await prepareCanonicalInvocation(protocol.id, invocation)
  if (!prepared.ok) {
    return err({ code: "canonical-invocation", error: prepared.error })
  }

  if (!isParsedForm(args, parsedArguments.value)) {
    return err({
      code: "invalid-arguments",
      mutation: definition.name,
      issues: [UNPARSED_ARGUMENTS_ISSUE],
    })
  }

  return ok({
    mutationId: parsedEnvelope.value.mutationId,
    createdAt: parsedEnvelope.value.createdAt,
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
      createdAt: options.prepared.createdAt,
      protocol: options.prepared.protocol,
      canonical: options.prepared.canonical,
      parseRefusal: options.parseRefusal,
    },
    (tx, stamp) =>
      options.run(tx, stamp, structuredClone(options.prepared.args))
  )
}
