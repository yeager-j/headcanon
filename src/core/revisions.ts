import { err, ok, type Result } from "serializable-result"

import { hasExactKeys, isPlainRecord } from "./admission"
import { isWellFormedUnicode } from "./unicode"

declare const axisIdBrand: unique symbol
declare const revisionBrand: unique symbol
declare const revisionVectorBrand: unique symbol
declare const acceptedStampBrand: unique symbol

/** A globally stable, non-empty address for one storage-owned monotonic revision line. */
export type AxisId = string & { readonly [axisIdBrand]: "AxisId" }

/** A validated non-negative safe integer on one revision axis. */
export type Revision = number & { readonly [revisionBrand]: "Revision" }

/**
 * The latest authoritative revision observed for each axis in a projection.
 *
 * Opaque: build one with {@link defineCanon} and read it only with
 * {@link revisionAt} and {@link revisionEntries}, because axis strings may
 * collide with `Object.prototype` members. It is a frozen plain object, so it
 * crosses the RSC boundary.
 */
export type RevisionVector = {
  readonly [revisionVectorBrand]: "RevisionVector"
}

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

/**
 * Every axis revision atomically advanced by one accepted mutation.
 *
 * Only a stamp accumulator (inside authority) or the {@link acceptedStamp}
 * parser (at a wire or storage boundary) produces one.
 */
export interface AcceptedStamp {
  readonly revisions: RevisionVector
  readonly [acceptedStampBrand]: "AcceptedStamp"
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
  | {
      readonly code: "invalid-revision-vector"
      readonly reason: "invalid-axis"
      readonly axis: string
    }
  | {
      readonly code: "invalid-revision-vector"
      readonly reason: "invalid-revision"
      readonly axis: string
      readonly error: RevisionValidationError
    }

/** Why an untrusted value could not become an accepted stamp. */
export type AcceptedStampValidationError =
  | {
      readonly code: "invalid-accepted-stamp"
      readonly reason: "not-plain-object" | "unexpected-field"
      readonly value: unknown
    }
  | {
      readonly code: "invalid-accepted-stamp"
      readonly reason: "invalid-revisions"
      readonly error: RevisionVectorValidationError
    }

/**
 * The one rule for a valid axis address: a non-empty, well-formed string.
 *
 * Construction ({@link axisId}, {@link revisionVector}) and the realtime
 * invalidation parser share it, so every axis the protocol admits can also be
 * notified. A lone surrogate is rejected because UTF-8 replaces it with
 * U+FFFD, so two distinct axes would share one channel name and cache tag.
 * @param value Candidate axis address.
 * @returns Whether the value is a non-empty string with no lone surrogate.
 */
export function isAxisAddress(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && isWellFormedUnicode(value)
  )
}

/**
 * Brands an application-owned, globally stable axis address.
 *
 * The application remains responsible for its axis namespace and stability.
 * Beyond being non-empty and well-formed Unicode, this constructor
 * deliberately imposes no grammar.
 * @param value Globally stable application-owned axis address.
 * @returns The same string carrying the `AxisId` compile-time brand.
 * @throws Error when the address is empty or contains a lone surrogate, a
 * programmer error.
 */
export function axisId(value: string): AxisId {
  if (!isAxisAddress(value)) {
    throw new Error(
      "An axis address must be a non-empty string with no lone surrogate"
    )
  }
  return value as AxisId
}

/**
 * Parses an untrusted value into a non-negative safe-integer revision.
 * @param value Candidate revision value from an external boundary.
 * @returns A validated branded revision or a typed validation failure.
 */
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

/**
 * Builds a vector from trusted, already-branded coordinates.
 *
 * A repeated axis keeps its highest revision, so passing the entries of
 * several vectors yields their per-axis maximum (the join in the product
 * order). Every coordinate is written with `defineProperty`, never assignment,
 * so an axis literally named `__proto__` becomes an own key instead of
 * invoking the prototype setter. The vector stays a plain (not null-prototype)
 * object because it crosses the RSC boundary inside a canon, and React refuses
 * to serialize null-prototype objects to Client Components.
 * @param entries Branded axis and revision pairs.
 * @returns A frozen revision vector.
 */
export function revisionVectorFrom(
  entries: Iterable<readonly [AxisId, Revision]>
): RevisionVector {
  const vector: Record<string, Revision> = {}
  for (const [axis, coordinate] of entries) {
    const current = Object.hasOwn(vector, axis) ? vector[axis] : undefined
    if (current !== undefined && current >= coordinate) continue
    Object.defineProperty(vector, axis, {
      value: coordinate,
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return Object.freeze(vector) as unknown as RevisionVector
}

/**
 * Parses a plain string-keyed object into an immutable revision vector.
 *
 * Validation stops at the first invalid coordinate and preserves its axis in
 * the typed error so adapters can report the failed boundary precisely.
 * @param value Candidate revision vector from an external boundary.
 * @returns An immutable validated vector or a typed validation failure.
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

  const coordinates: [AxisId, Revision][] = []
  for (const [rawAxis, rawRevision] of Object.entries(value)) {
    if (!isAxisAddress(rawAxis)) {
      return err({
        code: "invalid-revision-vector",
        reason: "invalid-axis",
        axis: rawAxis,
      })
    }
    const parsedRevision = revision(rawRevision)
    if (!parsedRevision.ok) {
      return err({
        code: "invalid-revision-vector",
        reason: "invalid-revision",
        axis: rawAxis,
        error: parsedRevision.error,
      })
    }
    coordinates.push([rawAxis as AxisId, parsedRevision.value])
  }

  return ok(revisionVectorFrom(coordinates))
}

/**
 * Reads one coordinate, treating inherited members as absent, so an axis
 * named `toString` reads as absent instead of `Object.prototype`'s member.
 * @param vector Revision vector to inspect.
 * @param axis Axis address to look up.
 * @returns The own revision at the axis, or `undefined` when absent.
 */
export function revisionAt(
  vector: RevisionVector,
  axis: AxisId
): Revision | undefined {
  return Object.hasOwn(vector, axis)
    ? (vector as unknown as Readonly<Record<string, Revision>>)[axis]
    : undefined
}

/**
 * Lists a vector's coordinates with their axis brand restored.
 * @param vector Revision vector to read.
 * @returns Every own axis and revision pair, in insertion order.
 */
export function revisionEntries(
  vector: RevisionVector
): readonly (readonly [AxisId, Revision])[] {
  return Object.entries(
    vector as unknown as Readonly<Record<string, Revision>>
  ) as [AxisId, Revision][]
}

/**
 * Mints the stamp for a vector that authority itself recorded. Package code
 * outside authority uses the {@link acceptedStamp} parser instead.
 * @param revisions Complete vector advanced by the accepted mutation.
 * @returns An immutable accepted stamp.
 */
export function stampRecordedRevisions(
  revisions: RevisionVector
): AcceptedStamp {
  return Object.freeze({ revisions }) as AcceptedStamp
}

/**
 * Parses an untrusted `{ revisions }` value into an accepted stamp.
 *
 * Use it wherever a stamp crosses a wire or storage boundary, such as a stored
 * receipt or a hand-written authority.
 * @param value Candidate stamp from an external boundary.
 * @returns An immutable accepted stamp or a typed validation failure.
 */
export function acceptedStamp(
  value: unknown
): Result<AcceptedStamp, AcceptedStampValidationError> {
  if (!isPlainRecord(value)) {
    return err({
      code: "invalid-accepted-stamp",
      reason: "not-plain-object",
      value,
    })
  }
  if (!hasExactKeys(value, ["revisions"])) {
    return err({
      code: "invalid-accepted-stamp",
      reason: "unexpected-field",
      value,
    })
  }

  const revisions = revisionVector(value.revisions)
  if (!revisions.ok) {
    return err({
      code: "invalid-accepted-stamp",
      reason: "invalid-revisions",
      error: revisions.error,
    })
  }
  return ok(stampRecordedRevisions(revisions.value))
}

function describeRevisionVectorError(
  error: RevisionVectorValidationError
): string {
  switch (error.reason) {
    case "not-plain-object":
      return `${error.code} (not-plain-object)`
    case "invalid-axis":
      return `${error.code} at axis ${JSON.stringify(error.axis)} (invalid-axis)`
    case "invalid-revision":
      return `${error.code} at axis ${JSON.stringify(error.axis)} (${error.error.reason})`
  }
}

/**
 * Builds a frozen {@link Canon} from a loader's value and the raw axis
 * revisions observed with it.
 *
 * An invalid revision is a loader data-integrity failure, so this throws
 * instead of returning a result. In a `"use cache"` loader, use
 * `defineCachedCanon` from `headcanon/next/server`, which also applies the axis
 * cache tags.
 * @param input Loader value and raw axis revisions observed together.
 * @returns A frozen canon carrying branded revisions.
 * @throws Error naming the reason, and the failing axis when there is one, when the revision vector is invalid.
 */
export function defineCanon<State>(input: {
  readonly value: State
  readonly revisions: Readonly<Record<string, number>>
}): Canon<State> {
  const revisions = revisionVector(input.revisions)
  if (!revisions.ok) {
    throw new Error(
      `defineCanon received an invalid revision vector: ${describeRevisionVectorError(revisions.error)}`
    )
  }

  return Object.freeze({ value: input.value, revisions: revisions.value })
}

/**
 * Returns whether one vector covers another in the product order.
 *
 * `revisions` covers `required` when every axis in `required` is present in
 * `revisions` at the same revision or later. Missing or behind axes do not
 * cover their coordinate; an empty requirement is covered immediately.
 * @param revisions Authoritative revisions to inspect, usually `canon.revisions`.
 * @param required Revisions that must be covered, usually `stamp.revisions`.
 * @returns Whether every required coordinate is present at or beyond its revision.
 */
export function covers(
  revisions: RevisionVector,
  required: RevisionVector
): boolean {
  return revisionEntries(required).every(([axis, requiredRevision]) => {
    const observed = revisionAt(revisions, axis)
    return observed !== undefined && observed >= requiredRevision
  })
}
