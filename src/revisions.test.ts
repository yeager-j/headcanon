import { describe, expect, it, vi } from "vitest"

import {
  acceptedStamp,
  axisId,
  axisInvalidation,
  covers,
  defineCanon,
  revision,
  revisionAt,
  revisionEntries,
  revisionVector,
  type Revision,
  type RevisionVector,
} from "./index"
import { revisionVectorFrom } from "./revisions"

function vector(input: Record<string, unknown>): RevisionVector {
  const result = revisionVector(input)
  if (!result.ok) throw new Error(`Invalid test vector: ${result.error.reason}`)
  return result.value
}

describe("revision", () => {
  it.each([
    [-1, "negative"],
    [1.5, "fractional"],
    [Number.NaN, "non-finite"],
    [Number.POSITIVE_INFINITY, "non-finite"],
    [Number.NEGATIVE_INFINITY, "non-finite"],
    [Number.MAX_SAFE_INTEGER + 1, "unsafe-integer"],
    ["1", "not-number"],
  ] as const)("rejects %s as %s", (value, reason) => {
    expect(revision(value)).toEqual({
      ok: false,
      error: { code: "invalid-revision", reason, value },
    })
  })

  it.each([0, 1, Number.MAX_SAFE_INTEGER])("accepts %s", (value) => {
    expect(revision(value)).toEqual({ ok: true, value })
  })
})

describe("axis addresses", () => {
  it("rejects an empty axis at construction", () => {
    expect(() => axisId("")).toThrow(
      "An axis address must be a non-empty string"
    )
  })

  it("rejects an empty axis inside an untrusted vector", () => {
    expect(revisionVector({ "": 1 })).toEqual({
      ok: false,
      error: {
        code: "invalid-revision-vector",
        reason: "invalid-axis",
        axis: "",
      },
    })
  })

  it("admits only axes that a realtime invalidation can also carry", () => {
    for (const axis of ["entity/one", " ", "__proto__", "a\u0000b"]) {
      const parsed = revisionVector({ [axis]: 1 })
      expect(parsed.ok).toBe(true)
      expect(
        axisInvalidation({ eventId: "event-1", axis, revision: 1 }).ok
      ).toBe(true)
    }
  })
})

describe("revisionVector", () => {
  it("nests a bad revision's error under its axis", () => {
    expect(revisionVector({ "entity/1/vitals": -1 })).toEqual({
      ok: false,
      error: {
        code: "invalid-revision-vector",
        reason: "invalid-revision",
        axis: "entity/1/vitals",
        error: { code: "invalid-revision", reason: "negative", value: -1 },
      },
    })
  })

  it.each([null, [], new Date(), "not-a-vector"])(
    "rejects non-record input %#",
    (value) => {
      expect(revisionVector(value)).toEqual({
        ok: false,
        error: {
          code: "invalid-revision-vector",
          reason: "not-plain-object",
          value,
        },
      })
    }
  )

  it("rejects accessor-backed coordinates without invoking them", () => {
    const getter = vi.fn(() => 1)
    const input = Object.defineProperty({}, "entity/1/vitals", {
      enumerable: true,
      get: getter,
    })

    expect(revisionVector(input)).toEqual({
      ok: false,
      error: {
        code: "invalid-revision-vector",
        reason: "not-plain-object",
        value: input,
      },
    })
    expect(getter).not.toHaveBeenCalled()
  })

  it("reads coordinates only through the module", () => {
    const parsed = vector({ "entity/one": 1 })

    // @ts-expect-error — a vector is opaque; index it through revisionAt.
    void parsed["entity/one"]
    expect(revisionEntries(parsed)).toEqual([[axisId("entity/one"), 1]])
  })
})

describe("revisionVectorFrom", () => {
  const one = axisId("entity/one")
  const two = axisId("entity/two")

  it("keeps the highest revision of a repeated axis", () => {
    const joined = revisionVectorFrom([
      [one, 2 as Revision],
      [two, 1 as Revision],
      [one, 1 as Revision],
      [one, 3 as Revision],
    ])

    expect(joined).toEqual({ [one]: 3, [two]: 1 })
    expect(Object.isFrozen(joined)).toBe(true)
  })
})

describe("acceptedStamp", () => {
  it("parses an exact { revisions } record into a frozen stamp", () => {
    const parsed = acceptedStamp({ revisions: { "entity/one": 2 } })

    expect(parsed).toEqual({
      ok: true,
      value: { revisions: { "entity/one": 2 } },
    })
    expect(parsed.ok && Object.isFrozen(parsed.value)).toBe(true)
  })

  it.each([null, [], "stamp"])("rejects non-record input %#", (value) => {
    expect(acceptedStamp(value)).toEqual({
      ok: false,
      error: {
        code: "invalid-accepted-stamp",
        reason: "not-plain-object",
        value,
      },
    })
  })

  it("rejects extra fields, which a canon would carry", () => {
    const canonShaped = { value: 1, revisions: { "entity/one": 2 } }

    expect(acceptedStamp(canonShaped)).toEqual({
      ok: false,
      error: {
        code: "invalid-accepted-stamp",
        reason: "unexpected-field",
        value: canonShaped,
      },
    })
  })

  it("nests the vector error for invalid revisions", () => {
    expect(acceptedStamp({ revisions: { "entity/one": 1.5 } })).toEqual({
      ok: false,
      error: {
        code: "invalid-accepted-stamp",
        reason: "invalid-revisions",
        error: {
          code: "invalid-revision-vector",
          reason: "invalid-revision",
          axis: "entity/one",
          error: { code: "invalid-revision", reason: "fractional", value: 1.5 },
        },
      },
    })
  })
})

describe("covers", () => {
  const vitals = axisId("entity/1/vitals")
  const inventory = axisId("entity/1/inventory")

  it("covers an empty requirement immediately", () => {
    expect(covers(vector({}), vector({}))).toBe(true)
  })

  it("covers an equal singleton revision", () => {
    expect(covers(vector({ [vitals]: 3 }), vector({ [vitals]: 3 }))).toBe(true)
  })

  it("covers a requirement when the observed revision is ahead", () => {
    expect(covers(vector({ [vitals]: 4 }), vector({ [vitals]: 3 }))).toBe(true)
  })

  it("does not cover a missing axis", () => {
    expect(
      covers(vector({ [vitals]: 3 }), vector({ [vitals]: 3, [inventory]: 1 }))
    ).toBe(false)
  })

  it("does not cover a behind axis", () => {
    expect(
      covers(
        vector({ [vitals]: 3, [inventory]: 1 }),
        vector({ [vitals]: 3, [inventory]: 2 })
      )
    ).toBe(false)
  })

  it("covers a multi-axis requirement only when every coordinate is covered", () => {
    expect(
      covers(
        vector({ [vitals]: 4, [inventory]: 2 }),
        vector({ [vitals]: 3, [inventory]: 2 })
      )
    ).toBe(true)
  })

  it("does not accept a stamp or canon where a vector belongs", () => {
    const stamp = acceptedStamp({ revisions: { [vitals]: 1 } })
    if (!stamp.ok) throw new Error("Invalid test stamp")
    const canon = defineCanon({ value: null, revisions: { [vitals]: 1 } })

    // @ts-expect-error — pass `canon.revisions`, not the canon.
    void (() => covers(canon, stamp.value.revisions))
    // @ts-expect-error — pass `stamp.revisions`, not the stamp.
    void (() => covers(canon.revisions, stamp.value))
  })
})

describe("covers is the product order (exhaustive over two axes)", () => {
  const axes = [axisId("a"), axisId("b")] as const
  const coordinates = [undefined, 0, 1, 2] as const
  const vectors = coordinates.flatMap((a) =>
    coordinates.map((b) =>
      vector({
        ...(a === undefined ? {} : { [axes[0]]: a }),
        ...(b === undefined ? {} : { [axes[1]]: b }),
      })
    )
  )
  const sameCoordinates = (left: RevisionVector, right: RevisionVector) =>
    axes.every((axis) => revisionAt(left, axis) === revisionAt(right, axis))
  const join = (left: RevisionVector, right: RevisionVector) =>
    revisionVectorFrom([...revisionEntries(left), ...revisionEntries(right)])

  it("is reflexive, antisymmetric, and transitive", () => {
    for (const x of vectors) {
      expect(covers(x, x)).toBe(true)
      for (const y of vectors) {
        if (covers(x, y) && covers(y, x)) {
          expect(sameCoordinates(x, y)).toBe(true)
        }
        for (const z of vectors) {
          if (covers(x, y) && covers(y, z)) expect(covers(x, z)).toBe(true)
        }
      }
    }
  })

  it("has the per-axis maximum as the least upper bound", () => {
    for (const x of vectors) {
      for (const y of vectors) {
        const upper = join(x, y)
        expect(covers(upper, x) && covers(upper, y)).toBe(true)
        for (const z of vectors) {
          if (covers(z, x) && covers(z, y)) expect(covers(z, upper)).toBe(true)
        }
      }
    }
  })
})

describe("defineCanon", () => {
  const vitals = axisId("entity/1/vitals")
  const inventory = axisId("entity/1/inventory")

  it("brands raw revision integers into an immutable canon", () => {
    const canon = defineCanon({
      value: { hp: 4 },
      revisions: { [vitals]: 3, [inventory]: 0 },
    })

    expect(canon.value).toEqual({ hp: 4 })
    expect(canon.revisions).toEqual({ [vitals]: 3, [inventory]: 0 })
    expect(Object.isFrozen(canon)).toBe(true)
    expect(Object.isFrozen(canon.revisions)).toBe(true)
    expect(covers(canon.revisions, vector({ [vitals]: 3 }))).toBe(true)
  })

  it("accepts any raw record, since it parses every key at runtime", () => {
    const loaded: Record<string, number> = { "entity/1/vitals": 1 }

    expect(defineCanon({ value: null, revisions: loaded }).revisions).toEqual(
      loaded
    )
  })

  it("accepts an empty revision vector", () => {
    expect(defineCanon({ value: null, revisions: {} }).revisions).toEqual({})
  })

  it.each([
    [-1, "negative"],
    [1.5, "fractional"],
    [Number.NaN, "non-finite"],
    [Number.MAX_SAFE_INTEGER + 1, "unsafe-integer"],
  ])("throws on an invalid revision (%s)", (bad, reason) => {
    expect(() =>
      defineCanon({ value: null, revisions: { [vitals]: bad } })
    ).toThrow(new RegExp(`${vitals}.*${reason}`))
  })

  it("throws on an empty axis", () => {
    expect(() => defineCanon({ value: null, revisions: { "": 1 } })).toThrow(
      'at axis "" (invalid-axis)'
    )
  })
})

describe("revision vectors cross the RSC boundary safely", () => {
  // A canon is carried to Client Components as an RSC prop and an accepted
  // stamp rides a Server Action response, so React's serializer sees both. It
  // rejects null-prototype objects ("Only plain objects ... can be passed to
  // Client Components"), which is why the vector is plain — and why the two
  // protections a null prototype used to give are restored explicitly.
  it("produces plain, serializable objects", () => {
    const canon = defineCanon({
      value: { hp: 3 },
      revisions: { [axisId("entity/1/vitals")]: 4 },
    })

    expect(Object.getPrototypeOf(canon.revisions)).toBe(Object.prototype)
    // The exact predicate React's serializer applies to a candidate prop.
    expect(
      Object.getPrototypeOf(canon.revisions) === Object.prototype ||
        Object.getPrototypeOf(canon.revisions) === null
    ).toBe(true)
    expect(JSON.parse(JSON.stringify(canon.revisions))).toEqual({
      "entity/1/vitals": 4,
    })
  })

  it("stores a __proto__ axis as an own key without moving the prototype", () => {
    // Parsed, not a literal: `{ __proto__: 7 }` sets the prototype instead of
    // creating an own key, while `JSON.parse` creates the own property — which
    // is also how such a key would really arrive (a wire payload).
    const hostile = vector(
      JSON.parse('{"__proto__": 7, "entity/1/vitals": 2}') as Record<
        string,
        unknown
      >
    )

    expect(Object.getPrototypeOf(hostile)).toBe(Object.prototype)
    expect(Object.hasOwn(hostile, "__proto__")).toBe(true)
    expect(revisionAt(hostile, axisId("__proto__"))).toBe(7)
    expect(revisionEntries(hostile)).toContainEqual([axisId("__proto__"), 7])
  })

  it("reads an inherited member as an absent axis", () => {
    const empty = vector({})

    // Plain-object indexing would hand back Object.prototype.toString here.
    expect(revisionAt(empty, axisId("toString"))).toBeUndefined()
    expect(revisionAt(empty, axisId("constructor"))).toBeUndefined()
  })

  it("does not treat an inherited member as coverage", () => {
    // With a raw `revisions[axis]` lookup this returns true: the inherited
    // function is `!== undefined` and compares as NaN-ish nonsense.
    expect(covers(vector({}), vector({ toString: 1 }))).toBe(false)
  })
})
