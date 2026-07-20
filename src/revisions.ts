import { err, ok, type Result } from "@workspace/result"

declare const axisIdBrand: unique symbol
declare const revisionBrand: unique symbol

/** A globally stable address for one storage-owned monotonic revision line. */
export type AxisId = string & { readonly [axisIdBrand]: "AxisId" }

/** A validated non-negative safe integer on one revision axis. */
export type Revision = number & { readonly [revisionBrand]: "Revision" }

/** The latest authoritative revision observed for each axis in a projection. */
export type RevisionVector = Readonly<Record<AxisId, Revision>>

/**
 * A complete authoritative projection and the revisions observed with it.
 *
 * `value` and `revisions` must come from one snapshot-preserving observation;
 * constructing this shape does not prove that storage-level invariant.
 */
export interface Canon<State> {
  readonly value: State
  readonly revisions: RevisionVector
}

/** Every axis revision atomically advanced by one accepted mutation. */
export interface AcceptedStamp {
  readonly revisions: RevisionVector
}

/** Why an untrusted value could not become a losslessly ordered revision. */
export type RevisionValidationError = {
  readonly code: "invalid-revision"
  readonly reason:
    | "not-number"
    | "non-finite"
    | "fractional"
    | "unsafe-integer"
    | "negative"
  readonly value: unknown
}

/** Why an untrusted value could not become a complete revision vector. */
export type RevisionVectorValidationError =
  | {
      readonly code: "invalid-revision-vector"
      readonly reason: "not-plain-object"
      readonly value: unknown
    }
  | (RevisionValidationError & { readonly axis: string })

/**
 * Brands an application-owned, globally stable axis address.
 *
 * The application remains responsible for its axis namespace and stability;
 * this constructor deliberately does not impose an address grammar.
 */
export const axisId = (value: string): AxisId => value as AxisId

/** Parses an untrusted value into a non-negative safe-integer revision. */
export function revision(
  value: unknown
): Result<Revision, RevisionValidationError> {
  if (typeof value !== "number") {
    return err({ code: "invalid-revision", reason: "not-number", value })
  }
  if (!Number.isFinite(value)) {
    return err({ code: "invalid-revision", reason: "non-finite", value })
  }
  if (!Number.isInteger(value)) {
    return err({ code: "invalid-revision", reason: "fractional", value })
  }
  if (!Number.isSafeInteger(value)) {
    return err({ code: "invalid-revision", reason: "unsafe-integer", value })
  }
  if (value < 0) {
    return err({ code: "invalid-revision", reason: "negative", value })
  }

  return ok(value as Revision)
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

/**
 * Parses a plain string-keyed object into an immutable revision vector.
 *
 * Validation stops at the first invalid coordinate and preserves its axis in
 * the typed error so adapters can report the failed boundary precisely.
 */
export function revisionVector(
  value: unknown
): Result<RevisionVector, RevisionVectorValidationError> {
  if (!isPlainRecord(value)) {
    return err({
      code: "invalid-revision-vector",
      reason: "not-plain-object",
      value,
    })
  }

  const revisions = Object.create(null) as Record<AxisId, Revision>
  for (const [rawAxis, rawRevision] of Object.entries(value)) {
    const parsedRevision = revision(rawRevision)
    if (!parsedRevision.ok) {
      return err({ ...parsedRevision.error, axis: rawAxis })
    }
    revisions[axisId(rawAxis)] = parsedRevision.value
  }

  return ok(Object.freeze(revisions))
}

/** Wraps a validated revision vector as the atomic result of acceptance. */
export const acceptedStamp = (revisions: RevisionVector): AcceptedStamp =>
  Object.freeze({ revisions })

/**
 * Returns whether canon covers every coordinate in an accepted stamp.
 *
 * Coverage is the product order over axis revisions. Missing or behind axes do
 * not cover their coordinate; an empty stamp is covered immediately.
 */
export function covers<State>(
  canon: Pick<Canon<State>, "revisions">,
  stamp: AcceptedStamp
): boolean {
  for (const rawAxis of Object.keys(stamp.revisions)) {
    const axis = axisId(rawAxis)
    const acceptedRevision = stamp.revisions[axis]
    const canonRevision = canon.revisions[axis]

    if (
      acceptedRevision === undefined ||
      canonRevision === undefined ||
      canonRevision < acceptedRevision
    ) {
      return false
    }
  }

  return true
}
