import type { MutationAttemptFailure } from "../core/authority"

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
  | { readonly kind: "accepted" }
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
 * Denies the mutation from `screen`, `admit`, or `execute`. The generated
 * action returns `ok({ kind: "denied" })` with no reason, unlike a refusal.
 * @returns A denied decision.
 */
export function denyMutation(): { readonly kind: "denied" } {
  return Object.freeze({ kind: "denied" })
}

/** Returns the terminal accepted decision for a command attempt.
 * @returns An accepted command decision.
 */
export function acceptMutation(): { readonly kind: "accepted" } {
  return Object.freeze({ kind: "accepted" })
}

/** Returns a structured refusal that is safe to record and replay.
 * @param error Public refusal value.
 * @returns A refused command decision.
 */
export function refuseMutation<Refusal>(
  error: Refusal
): MutationCommandDecision<Refusal> {
  return Object.freeze({ kind: "refused", error })
}
