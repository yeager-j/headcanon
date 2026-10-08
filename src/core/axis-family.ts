import type { StandardSchemaV1 } from "@standard-schema/spec"
import { err, ok, type Result } from "serializable-result"

import { axisId, type AxisId } from "./revisions"

const AXIS_SEPARATOR = "/"

/** A schema for one key segment: it takes a string and returns it unchanged. */
type KeySegmentSchema = StandardSchemaV1<string, string>

/** Named key segments, in the order they appear in the axis. */
type KeyShape = Readonly<Record<string, KeySegmentSchema>>

type KeyOfShape<Shape extends KeyShape> = {
  readonly [Name in keyof Shape]: StandardSchemaV1.InferOutput<Shape[Name]>
}

/**
 * Why {@link AxisFamily.parse} rejected an axis of its own family.
 *
 * - `segment-count`: the axis has more or fewer key segments than the family.
 * - `empty-segment`: a key segment is empty.
 * - `key-rejected`: the key schema rejected a segment, or would change it.
 */
export type AxisKeyError = {
  readonly code: "invalid-axis-key"
  readonly reason: "segment-count" | "empty-segment" | "key-rejected"
  readonly axis: string
}

/**
 * Builds and parses the axes of one family, such as `notes/<noteId>`.
 *
 * Make one with {@link defineAxis}. `parse` is the exact inverse of `of`: it
 * returns the key that `of` encoded, and accepts no other string of the
 * family.
 */
export interface AxisFamily<Key> {
  /**
   * Builds the axis for a trusted key.
   * @throws Error when a key segment is empty, contains `/`, or fails the
   * key schema. This is a programmer error at a trusted call site.
   */
  of(key: Key): AxisId

  /**
   * Reads the key from an untrusted axis, such as one a browser requests.
   * @returns `null` when the axis belongs to another family, a failure when
   * it belongs to this family but its key is malformed, or the key.
   */
  parse(axis: string): Result<Key, AxisKeyError> | null
}

/** How a family turns its key into segments and back. */
interface KeyCodec<Key> {
  readonly schemas: readonly KeySegmentSchema[]
  toSegments(key: Key): readonly string[]
  fromSegments(segments: readonly string[]): Key
}

/**
 * Defines a family of axes that share a name, such as `notes`.
 *
 * An axis is the family name followed by each key segment, separated by `/`.
 * Key segments are never escaped: each must be non-empty, contain no `/`, and
 * pass its schema unchanged. Schemas must validate synchronously; `of` and
 * `parse` throw otherwise. Pass one schema for a single key, or an object of
 * schemas for named segments, such as a tenant and a record. Give each family
 * a unique name: two families with one name share their axes.
 * @param family A non-empty name that does not contain `/`.
 * @param key The key schema, or an object of segment schemas in axis order.
 * @returns The family, which builds axes with `of` and reads them with `parse`.
 * @throws Error when the family name is empty or contains `/`, or the object
 * of segment schemas is empty.
 * @example
 * const noteAxis = defineAxis("notes", z.uuid())
 * noteAxis.of(noteId) // "notes/<noteId>"
 * noteAxis.parse(axis) // ok(noteId), err(...), or null for another family
 *
 * const tenantNoteAxis = defineAxis("tenant-notes", {
 *   tenantId: z.uuid(),
 *   noteId: z.uuid(),
 * })
 * tenantNoteAxis.of({ tenantId, noteId }) // "tenant-notes/<tenantId>/<noteId>"
 */
export function defineAxis<Schema extends KeySegmentSchema>(
  family: string,
  key: Schema
): AxisFamily<StandardSchemaV1.InferOutput<Schema>>
export function defineAxis<Shape extends KeyShape>(
  family: string,
  key: Shape
): AxisFamily<KeyOfShape<Shape>>
export function defineAxis(
  family: string,
  key: KeySegmentSchema | KeyShape
): AxisFamily<unknown> {
  if (family.length === 0 || family.includes(AXIS_SEPARATOR)) {
    throw new Error(
      `An axis family name must be non-empty and must not contain "${AXIS_SEPARATOR}"`
    )
  }

  const codec = keyCodec(key)
  const prefix = family + AXIS_SEPARATOR

  const parse = (axis: string): Result<unknown, AxisKeyError> | null => {
    if (!axis.startsWith(prefix)) return null

    const segments = axis.slice(prefix.length).split(AXIS_SEPARATOR)
    const reason = segmentsProblem(codec.schemas, segments)
    if (reason) return err({ code: "invalid-axis-key", reason, axis })

    return ok(codec.fromSegments(segments))
  }

  const of = (value: unknown): AxisId => {
    const address = prefix + codec.toSegments(value).join(AXIS_SEPARATOR)
    // `of` accepts only what `parse` reads back, so the two cannot drift.
    const parsed = parse(address)

    if (!parsed?.ok) {
      throw new Error(
        `Invalid key for axis family "${family}": each key segment must be non-empty, contain no "${AXIS_SEPARATOR}", and pass its schema unchanged`
      )
    }

    return axisId(address)
  }

  return Object.freeze({ of, parse })
}

function keyCodec(key: KeySegmentSchema | KeyShape): KeyCodec<unknown> {
  if (isStandardSchema(key)) {
    return {
      schemas: [key],
      toSegments: (value) => [value as string],
      fromSegments: ([segment]) => segment,
    }
  }

  const names = Object.keys(key)
  if (names.length === 0) {
    throw new Error("An axis family needs at least one key segment")
  }

  return {
    schemas: Object.values(key),
    // A missing segment encodes as empty, which `of` then rejects.
    toSegments: (value) =>
      names.map((name) => (value as Record<string, string>)[name] ?? ""),
    fromSegments: (segments) =>
      Object.freeze(
        Object.fromEntries(names.map((name, index) => [name, segments[index]]))
      ),
  }
}

function isStandardSchema(
  key: KeySegmentSchema | KeyShape
): key is KeySegmentSchema {
  return "~standard" in key
}

function segmentsProblem(
  schemas: readonly KeySegmentSchema[],
  segments: readonly string[]
): AxisKeyError["reason"] | undefined {
  if (segments.length !== schemas.length) return "segment-count"
  if (segments.some((segment) => segment.length === 0)) return "empty-segment"

  const accepted = segments.every((segment, index) => {
    const schema = schemas[index]
    return schema !== undefined && acceptsUnchanged(schema, segment)
  })
  return accepted ? undefined : "key-rejected"
}

/**
 * Whether the schema accepts the segment and returns it unchanged. A schema
 * that changes the segment would make two axes parse to one key.
 * @throws Error when the schema validates asynchronously.
 */
function acceptsUnchanged(schema: KeySegmentSchema, segment: string): boolean {
  const validated = schema["~standard"].validate(segment)
  if ("then" in validated) {
    throw new Error("Axis key schemas must validate synchronously")
  }

  return !validated.issues && validated.value === segment
}
