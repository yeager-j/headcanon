import type { StandardSchemaV1 } from "@standard-schema/spec"
import { describe, expect, expectTypeOf, it } from "vitest"

import { ok, type Result } from "@workspace/result"

import {
  defineMutation,
  defineProtocol,
  type MutationErrorOf,
  type MutationInvocation,
  type ProtocolInvocation,
} from "./index"

type AmountArgs = { readonly amount: number }

const amountSchema: StandardSchemaV1<unknown, AmountArgs> = {
  "~standard": {
    version: 1,
    vendor: "headcanon-test",
    validate(value) {
      if (
        typeof value === "object" &&
        value !== null &&
        "amount" in value &&
        typeof value.amount === "number"
      ) {
        return { value: { amount: value.amount } }
      }
      return { issues: [{ message: "Expected an amount" }] }
    },
  },
}

type PredictionRefusal = { readonly code: "predicted" }
type AuthorityRefusal = { readonly code: "authoritative" }

const authorityRefusalSchema: StandardSchemaV1<unknown, AuthorityRefusal> = {
  "~standard": {
    version: 1,
    vendor: "headcanon-test",
    validate(value) {
      return { value: value as AuthorityRefusal }
    },
  },
}

const correlated = defineMutation({
  name: "counter.correlated",
  args: amountSchema,
  refusal: authorityRefusalSchema,
  predict(state: number): Result<number, PredictionRefusal> {
    return ok(state)
  },
})

const increment = defineMutation({
  name: "counter.increment",
  args: amountSchema,
  predict(state: number, args) {
    return ok(state + args.amount)
  },
})

const reset = defineMutation({
  name: "counter.reset",
  args: amountSchema,
  predict(_state: number, args) {
    return ok(args.amount)
  },
})

const append = defineMutation({
  name: "text.append",
  args: amountSchema,
  predict(state: string, args) {
    return ok(state + args.amount)
  },
})

function rejectInvalidProtocolsAtCompileTime() {
  function helper() {
    return undefined
  }

  defineProtocol({
    id: "test.invalid.v1",
    // @ts-expect-error — protocol entries must be mutation definitions.
    mutations: [helper],
  })
  defineProtocol({
    id: "test.mixed-state.v1",
    // @ts-expect-error — every mutation in one root shares its state type.
    mutations: [increment, append],
  })
}
void rejectInvalidProtocolsAtCompileTime

describe("defineMutation", () => {
  it("returns a typed invocation factory with its protocol metadata", () => {
    const invocation = increment({ amount: 2 })

    expect(invocation).toEqual({
      name: "counter.increment",
      args: { amount: 2 },
    })
    expect(increment.name).toBe("counter.increment")
    expect(increment.args).toBe(amountSchema)
    expect(increment.predict(3, invocation.args)).toEqual({
      ok: true,
      value: 5,
    })

    expectTypeOf(invocation).toEqualTypeOf<
      MutationInvocation<"counter.increment", AmountArgs>
    >()
    expectTypeOf(increment.name).toEqualTypeOf<"counter.increment">()
  })

  it("rejects incorrect invocation arguments at compile time", () => {
    // @ts-expect-error — the schema's inferred output requires a numeric amount.
    increment({ amount: "2" })
  })

  it("correlates predictor and authority errors to the invocation", () => {
    const invocation = correlated({ amount: 1 })

    expectTypeOf(invocation).toEqualTypeOf<
      MutationInvocation<
        "counter.correlated",
        AmountArgs,
        PredictionRefusal | AuthorityRefusal
      >
    >()
    expectTypeOf<MutationErrorOf<typeof correlated>>().toEqualTypeOf<
      PredictionRefusal | AuthorityRefusal
    >()
  })
})

describe("defineProtocol", () => {
  it("registers each stable mutation name once", () => {
    const protocol = defineProtocol({
      id: "test.counter.v1",
      mutations: [increment, reset],
    })

    expect(protocol.id).toBe("test.counter.v1")
    expect(protocol.mutationsByName["counter.increment"]).toBe(increment)
    expect(protocol.mutationsByName["counter.reset"]).toBe(reset)
    expect(Object.isFrozen(protocol.mutationsByName)).toBe(true)

    expectTypeOf<ProtocolInvocation<typeof protocol>>().toEqualTypeOf<
      | MutationInvocation<"counter.increment", AmountArgs>
      | MutationInvocation<"counter.reset", AmountArgs>
    >()
  })

  it("rejects duplicate stable names", () => {
    const duplicate = defineMutation({
      name: "counter.increment",
      args: amountSchema,
      predict(state: number) {
        return ok(state)
      },
    })

    expect(() =>
      defineProtocol({
        id: "test.counter.v1",
        mutations: [increment, duplicate],
      })
    ).toThrowError("Duplicate mutation name: counter.increment")
  })

  it("rejects malformed mutation functions at the protocol boundary", () => {
    function helper() {
      return undefined
    }

    expect(() =>
      defineProtocol({
        id: "test.invalid.v1",
        mutations: [helper as unknown as typeof increment],
      })
    ).toThrowError("Invalid mutation definition: helper")
  })
})
