import { describe, expect, it, vi } from "vitest"

import { hasExactKeys, isPlainRecord, plainRecordViolation } from "./admission"

describe("plainRecordViolation", () => {
  it.each([
    ["a plain object", { a: 1 }],
    ["a null-prototype object", Object.assign(Object.create(null), { a: 1 })],
    ["an empty object", {}],
  ])("admits %s", (_label, value) => {
    expect(plainRecordViolation(value)).toBeUndefined()
    expect(isPlainRecord(value)).toBe(true)
  })

  it.each([
    ["null", null],
    ["a string", "record"],
    ["an array", []],
    ["a class instance", new Date()],
    ["a map", new Map()],
  ])("rejects %s as not a plain object", (_label, value) => {
    expect(plainRecordViolation(value)).toEqual({ reason: "not-plain-object" })
    expect(isPlainRecord(value)).toBe(false)
  })

  it("rejects symbol keys", () => {
    expect(plainRecordViolation({ [Symbol("hidden")]: 1 })).toEqual({
      reason: "symbol-key",
    })
  })

  it("rejects hidden properties by key", () => {
    const hidden = Object.defineProperty({ a: 1 }, "b", { value: 2 })

    expect(plainRecordViolation(hidden)).toEqual({
      reason: "non-enumerable-property",
      key: "b",
    })
  })

  it("rejects accessors without invoking them", () => {
    const getter = vi.fn(() => 1)
    const accessor = Object.defineProperty({}, "a", {
      enumerable: true,
      get: getter,
    })

    expect(plainRecordViolation(accessor)).toEqual({
      reason: "accessor-property",
      key: "a",
    })
    expect(getter).not.toHaveBeenCalled()
  })
})

describe("hasExactKeys", () => {
  it("requires every expected key and no other", () => {
    expect(hasExactKeys({ a: 1, b: 2 }, ["b", "a"])).toBe(true)
    expect(hasExactKeys({ a: 1 }, ["a", "b"])).toBe(false)
    expect(hasExactKeys({ a: 1, b: 2, c: 3 }, ["a", "b"])).toBe(false)
    expect(hasExactKeys({ a: 1, c: 3 }, ["a", "b"])).toBe(false)
  })
})
