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

  const revisions = {} as Record<AxisId, Revision>
  for (const [rawAxis, rawRevision] of Object.entries(value)) {
    const parsedRevision = revision(rawRevision)
    if (!parsedRevision.ok) {
      return err({ ...parsedRevision.error, axis: rawAxis })
    }
    defineCoordinate(revisions, axisId(rawAxis), parsedRevision.value)
  }

  return ok(Object.freeze(revisions))
}

/**
 * Writes one coordinate as an own data property.
 *
 * A revision vector is a **plain** object, not a null-prototype one, because it
 * crosses the RSC boundary as part of a canon and React refuses to serialize
 * null-prototype objects to Client Components. That costs the two protections a
 * null prototype gave a map with application-supplied keys, so both are restored
 * explicitly: `defineProperty` (never assignment) so an axis literally named
 * `__proto__` becomes an own key instead of invoking the prototype setter, and
 * {@link revisionAt} for every read so an axis named `toString` reads as absent
 * instead of inheriting `Object.prototype`'s member.
 */
export function defineCoordinate(
  vector: Record<AxisId, Revision>,
  axis: AxisId,
  value: Revision
): void {
  Object.defineProperty(vector, axis, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  })
}

/**
 * Reads one coordinate, treating inherited members as absent — the only safe
 * way to index a vector whose keys are application-supplied axis strings. See
 * {@link defineCoordinate} for why the vector is not null-prototype.
 */
export function revisionAt(
  vector: RevisionVector,
  axis: AxisId
): Revision | undefined {
  return Object.hasOwn(vector, axis) ? vector[axis] : undefined
}

/** Wraps a validated revision vector as the atomic result of acceptance. */
export const acceptedStamp = (revisions: RevisionVector): AcceptedStamp =>
  Object.freeze({ revisions })

/**
 * Constructs a validated {@link Canon} for the uncached loader path.
 *
 * The application supplies axis-namespace keys and raw revision integers; this
 * parses them into an immutable {@link RevisionVector} (the parse-don't-validate
 * seam) and **throws** on an invalid coordinate — a loader-side data-integrity
 * failure, not an expected boundary. It is the uncached counterpart of
 * `tagVersionedBase`, which likewise throws; a `"use cache"` loader tags the
 * same shape instead. Both accept any `{ value, revisions }`.
 */
export function defineCanon<State>(input: {
  readonly value: State
  readonly revisions: Record<AxisId, number>
}): Canon<State> {
  const revisions = revisionVector(input.revisions)
  if (!revisions.ok) {
    const { error } = revisions
    const location =
      "axis" in error
        ? ` at axis ${JSON.stringify(error.axis)} (${error.reason})`
        : ` (${error.reason})`
    throw new Error(
      `defineCanon received an invalid revision vector: ${error.code}${location}`
    )
  }

  return Object.freeze({ value: input.value, revisions: revisions.value })
}

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
    const acceptedRevision = revisionAt(stamp.revisions, axis)
    const canonRevision = revisionAt(canon.revisions, axis)

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
