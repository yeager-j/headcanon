import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { Result } from "serializable-result"
import { describe, expect, expectTypeOf, it } from "vitest"

import { defineAxis, type AxisFamily, type AxisId, type AxisKeyError } from ".."

function stringSchema<Output extends string = string>(
  accepts: (value: string) => boolean
): StandardSchemaV1<string, Output> {
  return {
    "~standard": {
      version: 1,
      vendor: "headcanon-test",
      validate(value: unknown) {
        return typeof value === "string" && accepts(value)
          ? { value: value as Output }
          : { issues: [{ message: "rejected key" }] }
      },
    },
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const uuid = stringSchema((value) => UUID_PATTERN.test(value))
const anyString = stringSchema(() => true)

const NOTE_ID = "00000000-0000-4000-8000-000000000001"
const TENANT_ID = "00000000-0000-4000-8000-0000000000aa"

const trimming: StandardSchemaV1<string, string> = {
  "~standard": {
    version: 1,
    vendor: "headcanon-test",
    validate: (value: unknown) => ({ value: String(value).trim() }),
  },
}

const asynchronous: StandardSchemaV1<string, string> = {
  "~standard": {
    version: 1,
    vendor: "headcanon-test",
    validate: async (value: unknown) => ({ value: String(value) }),
  },
}

describe("defineAxis", () => {
  it("builds an axis from the family name and the key", () => {
    expect(defineAxis("notes", uuid).of(NOTE_ID)).toBe(`notes/${NOTE_ID}`)
  })

  it("parses an axis it built back to the key", () => {
    const noteAxis = defineAxis("notes", uuid)

    expect(noteAxis.parse(noteAxis.of(NOTE_ID))).toEqual({
      ok: true,
      value: NOTE_ID,
    })
  })

  it.each([
    "other/" + NOTE_ID,
    "notesx/" + NOTE_ID,
    "note/" + NOTE_ID,
    "notes",
    "Notes/" + NOTE_ID,
    "",
    "/notes/" + NOTE_ID,
  ])("returns null for %j, which is not in the family", (axis) => {
    expect(defineAxis("notes", uuid).parse(axis)).toBeNull()
  })

  it.each([undefined, null, 42, ["notes", NOTE_ID], { axis: "notes" }])(
    "returns null for the non-string %j",
    (axis) => {
      expect(defineAxis("notes", uuid).parse(axis)).toBeNull()
    }
  )

  it.each([
    ["notes/", "empty-segment"],
    [`notes/${NOTE_ID}/extra`, "segment-count"],
    [`notes/${NOTE_ID}/`, "segment-count"],
    ["notes/not-a-uuid", "key-rejected"],
    [`notes/${TENANT_ID.toUpperCase()}`, "key-rejected"],
  ] as const)("rejects the malformed key in %j as %s", (axis, reason) => {
    expect(defineAxis("notes", uuid).parse(axis)).toEqual({
      ok: false,
      error: { code: "invalid-axis-key", reason, axis },
    })
  })

  it.each(["\uD800", "\uDC00", "a\uD800b"])(
    "rejects the lone-surrogate key %j, which UTF-8 would merge with U+FFFD",
    (key) => {
      const axis = defineAxis("keys", anyString)

      expect(axis.parse(`keys/${key}`)).toEqual({
        ok: false,
        error: {
          code: "invalid-axis-key",
          reason: "key-rejected",
          axis: `keys/${key}`,
        },
      })
      expect(() => axis.of(key)).toThrow('Invalid key for axis family "keys"')
    }
  )

  it.each(["", "a/b", "/", "not-a-uuid"])(
    "throws when of receives the invalid key %j",
    (key) => {
      expect(() => defineAxis("notes", uuid).of(key)).toThrow(
        'Invalid key for axis family "notes"'
      )
    }
  )

  it.each(["", "a/b", "/", "\uD800", "a\uDC00"])(
    "rejects the family name %j",
    (family) => {
      expect(() => defineAxis(family, uuid)).toThrow(
        "An axis family name must be non-empty"
      )
    }
  )

  it("rejects a schema that changes the key", () => {
    const paddedAxis = defineAxis("padded", trimming)

    expect(() => paddedAxis.of(" a ")).toThrow(
      'Invalid key for axis family "padded"'
    )
    expect(paddedAxis.parse("padded/ a ")).toEqual({
      ok: false,
      error: {
        code: "invalid-axis-key",
        reason: "key-rejected",
        axis: "padded/ a ",
      },
    })
    expect(paddedAxis.parse("padded/a")).toEqual({ ok: true, value: "a" })
  })

  it("throws when the key schema validates asynchronously", () => {
    const slowAxis = defineAxis("slow", asynchronous)

    expect(() => slowAxis.of("a")).toThrow(
      "Axis key schemas must validate synchronously"
    )
    expect(() => slowAxis.parse("slow/a")).toThrow(
      "Axis key schemas must validate synchronously"
    )
  })

  it("parses exactly the strings it builds", () => {
    const families = [
      defineAxis("a", anyString),
      defineAxis("ab", anyString),
      defineAxis("a", { first: anyString, second: anyString }),
    ]
    const candidates = [
      "",
      "a",
      "a/",
      "a//",
      "a/b",
      "a/b/",
      "a//b",
      "a/b/c",
      "a/b/c/d",
      "ab",
      "ab/",
      "ab/a",
      "ab/a/b",
      "a/%2F",
      "a/b%2Fc",
      "a/ ",
      "a/\u0000",
      "a/\uD800",
      "a/__proto__",
      "a/__proto__/constructor",
      "a/./..",
      "b/a",
      "/a/b",
    ]

    for (const family of families) {
      for (const axis of candidates) {
        const parsed = family.parse(axis)
        if (!parsed?.ok) continue

        // Each family's key type differs; the round trip does not depend on it.
        expect((family as AxisFamily<unknown>).of(parsed.value)).toBe(axis)
      }
    }
  })

  it.each(["a", " ", "%2F", "__proto__", "..", "\uD83D\uDE00", "ü", "a b"])(
    "builds and parses the key %j back to itself",
    (key) => {
      const axis = defineAxis("keys", anyString)

      expect(axis.parse(axis.of(key))).toEqual({ ok: true, value: key })
    }
  )
})

describe("defineAxis with named key segments", () => {
  const workspaceNoteAxis = defineAxis("workspace-notes", {
    workspaceId: uuid,
    noteId: uuid,
  })

  it("builds an axis from the segments in shape order", () => {
    expect(
      workspaceNoteAxis.of({ noteId: NOTE_ID, workspaceId: TENANT_ID })
    ).toBe(`workspace-notes/${TENANT_ID}/${NOTE_ID}`)
  })

  it("parses an axis back to a frozen key", () => {
    const parsed = workspaceNoteAxis.parse(
      `workspace-notes/${TENANT_ID}/${NOTE_ID}`
    )

    expect(parsed).toEqual({
      ok: true,
      value: { workspaceId: TENANT_ID, noteId: NOTE_ID },
    })
    expect(parsed?.ok && Object.isFrozen(parsed.value)).toBe(true)
  })

  it("keeps a segment named __proto__ as an own key", () => {
    const shape: Record<string, typeof anyString> = {
      ["__proto__"]: anyString,
    }
    const axis = defineAxis("odd", shape)
    const parsed = axis.parse("odd/value")

    expect(parsed?.ok && Object.hasOwn(parsed.value, "__proto__")).toBe(true)
  })

  it.each([
    [`workspace-notes/${TENANT_ID}`, "segment-count"],
    [`workspace-notes/${TENANT_ID}/${NOTE_ID}/extra`, "segment-count"],
    [`workspace-notes/${TENANT_ID}/`, "empty-segment"],
    [`workspace-notes//${NOTE_ID}`, "empty-segment"],
    [`workspace-notes/${TENANT_ID}/not-a-uuid`, "key-rejected"],
  ] as const)("rejects the malformed key in %j as %s", (axis, reason) => {
    expect(workspaceNoteAxis.parse(axis)).toEqual({
      ok: false,
      error: { code: "invalid-axis-key", reason, axis },
    })
  })

  it("throws when of receives a segment that contains the separator", () => {
    const pairAxis = defineAxis("pairs", { left: anyString, right: anyString })

    expect(() => pairAxis.of({ left: "a/b", right: "c" })).toThrow(
      'Invalid key for axis family "pairs"'
    )
  })

  it("rejects an empty shape", () => {
    expect(() => defineAxis("empty", {})).toThrow(
      "An axis family needs at least one key segment"
    )
  })

  it("throws when of receives a missing or non-string segment", () => {
    const pairAxis = defineAxis("pairs", { left: anyString, right: anyString })

    expect(() => pairAxis.of({ left: "a" } as never)).toThrow(
      'Invalid key for axis family "pairs"'
    )
    expect(() => pairAxis.of({ left: "a", right: 1 } as never)).toThrow(
      'Invalid key for axis family "pairs"'
    )
  })

  it("treats a segment named ~standard as a segment, not a schema", () => {
    const markedAxis = defineAxis("marked", {
      "~standard": anyString,
      id: anyString,
    })
    const axis = markedAxis.of({ "~standard": "a", id: "b" })

    expect(axis).toBe("marked/a/b")
    expect(markedAxis.parse(axis)).toEqual({
      ok: true,
      value: { "~standard": "a", id: "b" },
    })
  })

  it("rejects a symbol-named segment", () => {
    expect(() =>
      defineAxis("symbols", { id: anyString, [Symbol("extra")]: anyString })
    ).toThrow("Axis key segments must have string names")
  })
})

describe("defineAxis types", () => {
  it("infers the key from one schema", () => {
    const noteAxis = defineAxis("notes", uuid)

    expectTypeOf(noteAxis).toEqualTypeOf<AxisFamily<string>>()
    expectTypeOf(noteAxis.of).returns.toEqualTypeOf<AxisId>()
    expectTypeOf(noteAxis.parse).returns.toEqualTypeOf<Result<
      string,
      AxisKeyError
    > | null>()
  })

  it("keeps a narrowed key type from the schema output", () => {
    const colorAxis = defineAxis(
      "colors",
      stringSchema<"red" | "blue">(
        (value) => value === "red" || value === "blue"
      )
    )

    expectTypeOf(colorAxis).toEqualTypeOf<AxisFamily<"red" | "blue">>()
    // @ts-expect-error — "green" is not a key of this family.
    expect(() => colorAxis.of("green")).toThrow()
  })

  it("infers an object key from named segments", () => {
    const workspaceNoteAxis = defineAxis("workspace-notes", {
      workspaceId: uuid,
      noteId: uuid,
    })

    expectTypeOf(workspaceNoteAxis).toEqualTypeOf<
      AxisFamily<{ readonly workspaceId: string; readonly noteId: string }>
    >()
    // @ts-expect-error — a key with named segments needs every segment.
    expect(() => workspaceNoteAxis.of({ workspaceId: TENANT_ID })).toThrow()
  })

  it("throws when of receives a non-string key from untyped code", () => {
    expect(() => defineAxis("items", anyString).of(1 as never)).toThrow(
      'Invalid key for axis family "items"'
    )
  })

  it("leaves symbol-named properties out of the key type", () => {
    const extra = Symbol("extra")
    // Never called: defineAxis rejects the symbol at runtime.
    const define = () =>
      defineAxis("symbols", { id: anyString, [extra]: anyString })

    expectTypeOf<ReturnType<typeof define>>().toEqualTypeOf<
      AxisFamily<{ readonly id: string }>
    >()
  })

  it("refuses a key schema whose output is not a string", () => {
    const numeric: StandardSchemaV1<string, number> = {
      "~standard": {
        version: 1,
        vendor: "headcanon-test",
        validate: (value: unknown) => ({ value: Number(value) }),
      },
    }

    // @ts-expect-error — axis keys are strings.
    defineAxis("numbers", numeric)
  })
})
