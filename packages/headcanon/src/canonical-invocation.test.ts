import { afterEach, describe, expect, it, vi } from "vitest"

import { canonicalInvocation, type MutationInvocation } from "./index"

function invocation(args: unknown): MutationInvocation<"test.mutate", unknown> {
  return { name: "test.mutate", args }
}

async function canonical(args: unknown) {
  const result = await canonicalInvocation("test.protocol.v1", invocation(args))
  if (!result.ok)
    throw new Error(`Canonicalization failed: ${result.error.code}`)
  return result.value
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("canonicalInvocation", () => {
  it("canonicalizes reordered and nested object keys identically", async () => {
    const first = await canonical({ z: 1, nested: { b: true, a: null }, a: 2 })
    const second = await canonical({ a: 2, nested: { a: null, b: true }, z: 1 })

    expect(first.json).toBe(
      '{"invocation":{"args":{"a":2,"nested":{"a":null,"b":true},"z":1},"name":"test.mutate"},"protocol":"test.protocol.v1"}'
    )
    expect(second.json).toBe(first.json)
    expect(second.bytes).toEqual(first.bytes)
    expect(second.sha256).toBe(first.sha256)
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it("uses RFC UTF-16 key ordering and preserves Unicode strings", async () => {
    const result = await canonical({
      "\u20ac": "Euro Sign",
      "\r": "Carriage Return",
      "\ufb33": "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "😀": "Emoji",
      "\u0080": "Control",
      ö: "Latin Small Letter O With Diaeresis",
    })

    expect(result.json).toContain(
      '"args":{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","😀":"Emoji","דּ":"Hebrew Letter Dalet With Dagesh"}'
    )
  })

  it("uses canonical numeric representations", async () => {
    const result = await canonical({
      negativeZero: -0,
      small: 1e-7,
      threshold: 0.000001,
      large: 1e21,
      precise: Number("333333333.33333329"),
    })

    expect(result.json).toContain(
      '"large":1e+21,"negativeZero":0,"precise":333333333.3333333,"small":1e-7,"threshold":0.000001'
    )
  })

  it("preserves order-significant arrays", async () => {
    const first = await canonical(["heal", "damage"])
    const second = await canonical(["damage", "heal"])

    expect(first.json).not.toBe(second.json)
    expect(first.sha256).not.toBe(second.sha256)
  })

  it("ignores inherited toJSON methods after validation", async () => {
    const expected = await canonical({ nested: ["safe"] })
    const objectToJson = vi.fn(() => ({ attacker: "object" }))
    const arrayToJson = vi.fn(() => ({ attacker: "array" }))
    let actual: Awaited<ReturnType<typeof canonical>>

    Object.defineProperty(Object.prototype, "toJSON", {
      configurable: true,
      value: objectToJson,
    })
    Object.defineProperty(Array.prototype, "toJSON", {
      configurable: true,
      value: arrayToJson,
    })

    try {
      actual = await canonical({ nested: ["safe"] })
    } finally {
      Reflect.deleteProperty(Array.prototype, "toJSON")
      Reflect.deleteProperty(Object.prototype, "toJSON")
    }

    expect(actual.json).toBe(expected.json)
    expect(actual.bytes).toEqual(expected.bytes)
    expect(actual.sha256).toBe(expected.sha256)
    expect(objectToJson).not.toHaveBeenCalled()
    expect(arrayToJson).not.toHaveBeenCalled()
  })

  it.each([
    ["undefined", { nested: undefined }, "undefined"],
    ["bigint", { nested: 1n }, "bigint"],
    ["function", { nested: () => undefined }, "function"],
    ["symbol", { nested: Symbol("value") }, "symbol"],
    ["non-finite number", { nested: Number.NaN }, "non-finite-number"],
    ["class instance", { nested: new Date() }, "class-instance"],
    ["lone surrogate", { nested: "\ud800" }, "invalid-unicode"],
  ] as const)("rejects %s before hashing", async (_label, args, reason) => {
    const digest = vi.spyOn(globalThis.crypto.subtle, "digest")

    await expect(
      canonicalInvocation("test.protocol.v1", invocation(args))
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "invalid-json-value",
        reason,
        path: ["invocation", "args", "nested"],
      },
    })
    expect(digest).not.toHaveBeenCalled()
  })

  it("rejects cyclic input before hashing", async () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const digest = vi.spyOn(globalThis.crypto.subtle, "digest")

    await expect(
      canonicalInvocation("test.protocol.v1", invocation(cyclic))
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "invalid-json-value",
        reason: "cyclic",
        path: ["invocation", "args", "self"],
      },
    })
    expect(digest).not.toHaveBeenCalled()
  })

  it("rejects array subclasses as class instances before hashing", async () => {
    class SpecialArray extends Array<string> {}

    const digest = vi.spyOn(globalThis.crypto.subtle, "digest")
    await expect(
      canonicalInvocation(
        "test.protocol.v1",
        invocation(new SpecialArray("value"))
      )
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "invalid-json-value",
        reason: "class-instance",
        path: ["invocation", "args"],
      },
    })
    expect(digest).not.toHaveBeenCalled()
  })

  it("rejects accessor-backed array entries without invoking them", async () => {
    const getter = vi.fn(() => "value")
    const args: string[] = []
    Object.defineProperty(args, "0", { enumerable: true, get: getter })
    args.length = 1

    const digest = vi.spyOn(globalThis.crypto.subtle, "digest")
    await expect(
      canonicalInvocation("test.protocol.v1", invocation(args))
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "invalid-json-value",
        reason: "accessor-property",
        path: ["invocation", "args", 0],
      },
    })
    expect(getter).not.toHaveBeenCalled()
    expect(digest).not.toHaveBeenCalled()
  })
})
