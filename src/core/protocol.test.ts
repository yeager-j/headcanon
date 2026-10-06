import type { StandardSchemaV1 } from "@standard-schema/spec"
import { ok, type Result } from "serializable-result"
import { describe, expect, expectTypeOf, it } from "vitest"

import {
  defineMutation,
  defineProtocol,
  type MutationErrorOf,
  type MutationInvocation,
  type ProtocolInvocation,
} from ".."
import { prepareMutationRequest } from "./authority"
import { findMutation } from "./protocol"

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
  function plainFunction() {
    return undefined
  }

  defineProtocol({
    id: "test.invalid.v1",
    // @ts-expect-error — protocol entries must be mutation definitions.
    mutations: [plainFunction],
  })
  defineProtocol({
    id: "test.mixed-state.v1",
    // @ts-expect-error — every mutation in one root shares its state type.
    mutations: [increment, append],
  })

  const mixedArray = [increment, append]
  defineProtocol({
    id: "test.mixed-array.v1",
    // @ts-expect-error — a predeclared, non-const array gets the same check.
    mutations: mixedArray,
  })

  const mixedReadonlyArray: readonly (typeof increment | typeof append)[] = [
    increment,
    append,
  ]
  defineProtocol({
    id: "test.mixed-readonly-array.v1",
    // @ts-expect-error — so does a readonly array of a mutation union.
    mutations: mixedReadonlyArray,
  })

  const numberToString: StandardSchemaV1<number, string> = {
    "~standard": {
      version: 1,
      vendor: "headcanon-test",
      validate: (value) => ({ value: String(value) }),
    },
  }
  defineMutation({
    name: "counter.transformed",
    // @ts-expect-error — parsed output must be a valid input to re-parse.
    args: numberToString,
    predict: (state: number) => ok(state),
  })
}
void rejectInvalidProtocolsAtCompileTime

/** Appends "!" on every parse: output equals input type, but not its value. */
const shoutSchema: StandardSchemaV1<string, string> = {
  "~standard": {
    version: 1,
    vendor: "headcanon-test",
    validate: (value) =>
      typeof value === "string"
        ? { value: `${value}!` }
        : { issues: [{ message: "Expected text" }] },
  },
}

type StepInput = { readonly step?: number }
type StepOutput = { readonly step: number }

/** Fills a default: input and output types differ, output is valid input. */
const stepSchema: StandardSchemaV1<StepInput, StepOutput> = {
  "~standard": {
    version: 1,
    vendor: "headcanon-test",
    validate(value) {
      if (typeof value !== "object" || value === null) {
        return { issues: [{ message: "Expected an object" }] }
      }
      const step = (value as StepInput).step ?? 1
      return typeof step === "number"
        ? { value: { step } }
        : { issues: [{ message: "Expected a numeric step" }] }
    },
  },
}

const shout = defineMutation({
  name: "text.shout",
  args: shoutSchema,
  predict: (state: string, text) => ok(`${state}${text}`),
})

const step = defineMutation({
  name: "counter.step",
  args: stepSchema,
  predict: (state: number, args) => ok(state + args.step),
})

function envelope(
  protocol: { readonly id: string },
  invocation: { readonly name: string; readonly args: unknown }
) {
  return {
    protocol: protocol.id,
    mutationId: "00000000-0000-4000-8000-000000000000",
    invocation,
  }
}

describe("defineMutation", () => {
  it("returns a typed invocation factory with its protocol metadata", () => {
    const invocation = increment({ amount: 2 })

    expect(invocation).toEqual({
      name: "counter.increment",
      args: { amount: 2 },
    })
    expect(increment.name).toBe("counter.increment")
    expect(increment.args).toBe(amountSchema)
    expect(
      increment.predict(3, invocation.args, { mutationId: "mutation-1" })
    ).toEqual({
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

  it("takes parsed (output) arguments when input and output types differ", () => {
    expectTypeOf(step).parameter(0).toEqualTypeOf<StepOutput>()
    // @ts-expect-error — the default is filled by parsing, so callers pass it.
    step({})
    expect(
      step.predict(1, step({ step: 2 }).args, { mutationId: "m" })
    ).toEqual(ok(3))
  })

  it("keeps a deeply frozen copy of the arguments", () => {
    const args = { amount: 2 }
    const invocation = increment(args)
    args.amount = 3

    expect(invocation.args).toEqual({ amount: 2 })
    expect(Object.isFrozen(invocation)).toBe(true)
    expect(Object.isFrozen(invocation.args)).toBe(true)
  })

  it("reads the definition once, so later changes cannot alter the wire name", () => {
    const definition = {
      name: "counter.first",
      args: amountSchema,
      predict: (state: number) => ok(state),
    }
    const stable = defineMutation(definition)
    ;(definition as { name: string }).name = "counter.second"

    expect(stable.name).toBe("counter.first")
    expect(stable({ amount: 1 }).name).toBe("counter.first")
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
    expect(protocol.mutations).toEqual([increment, reset])
    expect(Object.isFrozen(protocol.mutations)).toBe(true)
    expect(findMutation(protocol, "counter.increment")).toBe(increment)
    expect(findMutation(protocol, "counter.reset")).toBe(reset)
    for (const unregisteredName of [
      "__proto__",
      "toString",
      "constructor",
      1,
    ]) {
      expect(findMutation(protocol, unregisteredName)).toBeUndefined()
    }

    expectTypeOf<ProtocolInvocation<typeof protocol>>().toEqualTypeOf<
      | MutationInvocation<"counter.increment", AmountArgs>
      | MutationInvocation<"counter.reset", AmountArgs>
    >()
  })

  it("accepts a predeclared array whose mutations share one state", () => {
    const sameState = [increment, reset]
    const protocol = defineProtocol({
      id: "test.array.v1",
      mutations: sameState,
    })

    expect(findMutation(protocol, "counter.reset")).toBe(reset)
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
    function plainFunction() {
      return undefined
    }

    expect(() =>
      defineProtocol({
        id: "test.invalid.v1",
        mutations: [plainFunction as unknown as typeof increment],
      })
    ).toThrowError("Invalid mutation definition: plainFunction")
  })
})

describe("parsed-form arguments at the authority", () => {
  const protocol = defineProtocol({
    id: "test.parsed-form.v1",
    mutations: [shout],
  })
  const stepProtocol = defineProtocol({
    id: "test.parsed-form.v1",
    mutations: [step],
  })

  it("refuses arguments a non-idempotent schema changes", async () => {
    const invocation = shout("hey")
    expect(shout.predict("", invocation.args, { mutationId: "m" })).toEqual(
      ok("hey")
    )

    await expect(
      prepareMutationRequest(protocol, envelope(protocol, invocation))
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "invalid-arguments",
        mutation: "text.shout",
        issues: [
          {
            message:
              "Arguments must arrive in parsed form: the mutation's argument schema changed them",
          },
        ],
      },
    })
  })

  it("admits parsed-form arguments when input and output types differ", async () => {
    const prepared = await prepareMutationRequest(
      stepProtocol,
      envelope(stepProtocol, step({ step: 2 }))
    )

    expect(prepared.ok && prepared.value.args).toEqual({ step: 2 })
  })

  it("refuses unparsed wire input that parsing would fill in", async () => {
    const prepared = await prepareMutationRequest(
      stepProtocol,
      envelope(stepProtocol, { name: "counter.step", args: {} })
    )

    expect(prepared.ok ? null : prepared.error.code).toBe("invalid-arguments")
  })
})
