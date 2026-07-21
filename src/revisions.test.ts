import { describe, expect, it, vi } from "vitest"

import {
  acceptedStamp,
  axisId,
  covers,
  defineCanon,
  revision,
  revisionVector,
  type Canon,
  type RevisionVector,
} from "./index"

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

describe("revisionVector", () => {
  it("rejects a bad revision with its axis", () => {
    expect(revisionVector({ "entity/1/vitals": -1 })).toEqual({
      ok: false,
      error: {
        code: "invalid-revision",
        reason: "negative",
        value: -1,
        axis: "entity/1/vitals",
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
})

describe("covers", () => {
  const vitals = axisId("entity/1/vitals")
  const inventory = axisId("entity/1/inventory")

  function canon(revisions: RevisionVector): Canon<null> {
    return { value: null, revisions }
  }

  it("covers an empty accepted stamp immediately", () => {
    expect(covers(canon(vector({})), acceptedStamp(vector({})))).toBe(true)
  })

  it("covers an equal singleton revision", () => {
    expect(
      covers(
        canon(vector({ [vitals]: 3 })),
        acceptedStamp(vector({ [vitals]: 3 }))
      )
    ).toBe(true)
  })

  it("covers a stamp when canon is ahead", () => {
    expect(
      covers(
        canon(vector({ [vitals]: 4 })),
        acceptedStamp(vector({ [vitals]: 3 }))
      )
    ).toBe(true)
  })

  it("does not cover a missing axis", () => {
    expect(
      covers(
        canon(vector({ [vitals]: 3 })),
        acceptedStamp(vector({ [vitals]: 3, [inventory]: 1 }))
      )
    ).toBe(false)
  })

  it("does not cover a behind axis", () => {
    expect(
      covers(
        canon(vector({ [vitals]: 3, [inventory]: 1 })),
        acceptedStamp(vector({ [vitals]: 3, [inventory]: 2 }))
      )
    ).toBe(false)
  })

  it("covers a multi-axis stamp only when every coordinate is covered", () => {
    expect(
      covers(
        canon(vector({ [vitals]: 4, [inventory]: 2 })),
        acceptedStamp(vector({ [vitals]: 3, [inventory]: 2 }))
      )
    ).toBe(true)
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
    // The branded vector is usable everywhere a RevisionVector is expected.
    expect(covers(canon, acceptedStamp(vector({ [vitals]: 3 })))).toBe(true)
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
})
