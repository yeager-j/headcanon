import type {
  MutationAcceptance,
  MutationAttemptFailure,
} from "../core/authority"

/**
 * A command's `screen` result: allowed, carrying the value `finalizeAccepted`
 * receives as `screened`, or denied. Build it with {@link allowScreening} or
 * {@link denyMutation}.
 */
export type MutationScreening<Screened> =
  | { readonly kind: "allowed"; readonly screened: Screened }
  | { readonly kind: "denied" }

/**
 * A command's `admit` result for one transaction attempt: allowed, carrying
 * trusted evidence for `execute`, or denied. Build it with
 * {@link allowAdmission} or {@link denyMutation}.
 */
export type MutationAdmission<Evidence> =
  | { readonly kind: "allowed"; readonly evidence: Evidence }
  | { readonly kind: "denied" }

/**
 * The application command's terminal decision inside one authority attempt.
 * A refusal or denial is the attempt failure the authority records as is.
 */
export type MutationCommandDecision<Refusal> =
  | MutationAcceptance
  | MutationAttemptFailure<Refusal>

/**
 * An operation command's acceptance: the result its receipt records and
 * every delivery returns. Build it with {@link acceptOperation}.
 */
export interface OperationAcceptance<Result> extends MutationAcceptance {
  readonly result: Result
}

/**
 * An operation command's terminal decision inside one authority attempt:
 * an acceptance with the operation's result, a refusal, or a denial.
 */
export type OperationCommandDecision<Result, Refusal> =
  | OperationAcceptance<Result>
  | MutationAttemptFailure<Refusal>

/**
 * Allows preflight screening. Pass the value `finalizeAccepted` receives as
 * `screened`, or nothing when finalization needs no context: `screened` is
 * then `undefined`.
 * @param screened Value retained for accepted finalization.
 * @returns An allowed screening decision.
 */
export function allowScreening(): MutationScreening<undefined>
export function allowScreening<Screened>(
  screened: Screened
): MutationScreening<Screened>
export function allowScreening<Screened>(
  screened?: Screened
): MutationScreening<Screened | undefined> {
  return Object.freeze({ kind: "allowed", screened })
}

/**
 * Allows transactional admission. Pass the trusted evidence `execute`
 * receives, or nothing when `execute` needs none: `evidence` is then
 * `undefined`.
 * @param evidence Trusted evidence produced during admission.
 * @returns An allowed admission decision.
 */
export function allowAdmission(): MutationAdmission<undefined>
export function allowAdmission<Evidence>(
  evidence: Evidence
): MutationAdmission<Evidence>
export function allowAdmission<Evidence>(
  evidence?: Evidence
): MutationAdmission<Evidence | undefined> {
  return Object.freeze({ kind: "allowed", evidence })
}

/**
 * Allows transactional admission.
 * @deprecated Use {@link allowAdmission}. This alias will be removed in the
 * next release.
 * @param evidence Trusted evidence produced during admission.
 * @returns An allowed admission decision.
 */
export const allowMutation = allowAdmission

/**
 * Allows preflight screening.
 * @deprecated Use {@link allowScreening}. This alias will be removed in the
 * next release.
 * @param screened Value retained for accepted finalization.
 * @returns An allowed screening decision.
 */
export const allowMutationScreening = allowScreening

/**
 * Denies the mutation or operation from `screen`, `admit`, or `execute`. The
 * generated action returns `ok({ kind: "denied" })` with no reason, unlike a
 * refusal.
 * @returns A denied decision.
 */
export function denyMutation(): { readonly kind: "denied" } {
  return Object.freeze({ kind: "denied" })
}

/**
 * Returns the terminal accepted decision for a command attempt. Call
 * `stamp.record` for each axis the attempt advances first. Pass
 * `{ unchanged: true }` when the command accepts and changes nothing, so its
 * stamp is empty and the client ends the prediction at once.
 * @param options `{ unchanged: true }` for an acceptance that records no axis.
 * @returns An accepted command decision.
 * @example
 * if (note.title === args.title) return acceptMutation({ unchanged: true })
 */
export function acceptMutation(options?: {
  readonly unchanged: true
}): MutationAcceptance {
  return options?.unchanged === true
    ? Object.freeze({ kind: "accepted", unchanged: true })
    : Object.freeze({ kind: "accepted" })
}

/**
 * Returns the terminal accepted decision for an operation's command, with
 * the result its receipt records. Call `stamp.record` for each axis the
 * attempt advances first. Call it with no argument when the operation
 * declares no result. Pass `{ unchanged: true }` when the command accepts and
 * changes nothing, so its stamp is empty.
 * @param result The operation's result. Its schema parses it before the receipt records it.
 * @param options `{ unchanged: true }` for an acceptance that records no axis.
 * @returns An accepted operation decision.
 * @example
 * stamp.record(runAxis.of(runId), 1)
 * return acceptOperation({ runId })
 */
export function acceptOperation(): OperationAcceptance<undefined>
export function acceptOperation<Result>(
  result: Result,
  options?: { readonly unchanged: true }
): OperationAcceptance<Result>
export function acceptOperation<Result>(
  result?: Result,
  options?: { readonly unchanged: true }
): OperationAcceptance<Result | undefined> {
  return options?.unchanged === true
    ? Object.freeze({ kind: "accepted", unchanged: true, result })
    : Object.freeze({ kind: "accepted", result })
}

/**
 * Returns a structured refusal that is safe to record and replay, from a
 * mutation's or an operation's command.
 * @param error Public refusal value.
 * @returns A refused command decision.
 */
export function refuseMutation<Refusal>(error: Refusal): {
  readonly kind: "refused"
  readonly error: Refusal
} {
  return Object.freeze({ kind: "refused", error })
}
