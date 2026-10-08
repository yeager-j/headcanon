import type { StandardSchemaV1 } from "@standard-schema/spec"
import { ok } from "serializable-result"
import { describe, expect, expectTypeOf, it } from "vitest"

import {
  acceptMutation,
  allowAdmission,
  allowMutation,
  allowMutationScreening,
  allowScreening,
  createMutationBinder,
  denyMutation,
  type MutationAdmission,
  type MutationScreening,
} from "."
import { defineMutation } from "../core/protocol"
import { createInMemoryMutationAuthority } from "../testing"

const passThrough: StandardSchemaV1<unknown, { readonly id: string }> = {
  "~standard": {
    version: 1,
    vendor: "headcanon-server-test",
    validate: (value) => ({ value: value as { readonly id: string } }),
  },
}

const touch = defineMutation({
  name: "server.touch",
  args: passThrough,
  refusal: passThrough,
  predict: (state: number) => ok(state),
})

describe("allowed outcomes", () => {
  it("allows with no argument and types the value as undefined", () => {
    const screening = allowScreening()
    const admission = allowAdmission()

    expectTypeOf(screening).toEqualTypeOf<MutationScreening<undefined>>()
    expectTypeOf(admission).toEqualTypeOf<MutationAdmission<undefined>>()
    expect(screening).toEqual({ kind: "allowed", screened: undefined })
    expect(admission).toEqual({ kind: "allowed", evidence: undefined })
    expect(Object.isFrozen(screening)).toBe(true)
    expect(Object.isFrozen(admission)).toBe(true)
  })

  it("carries a supplied value with its type", () => {
    const screening = allowScreening({ count: 1 })
    const admission = allowAdmission({ observed: 2 })

    expectTypeOf(screening).toEqualTypeOf<
      MutationScreening<{ count: number }>
    >()
    expectTypeOf(admission).toEqualTypeOf<
      MutationAdmission<{ observed: number }>
    >()
    expect(screening).toEqual({ kind: "allowed", screened: { count: 1 } })
    expect(admission).toEqual({ kind: "allowed", evidence: { observed: 2 } })
  })

  it("keeps the deprecated names as aliases", () => {
    expect(allowMutation).toBe(allowAdmission)
    expect(allowMutationScreening).toBe(allowScreening)
  })
})

describe("accepted outcome", () => {
  it("accepts with no argument, for a command that records its axes", () => {
    const accepted = acceptMutation()

    expect(accepted).toEqual({ kind: "accepted" })
    expect(Object.isFrozen(accepted)).toBe(true)
  })

  it("declares an explicit no-change acceptance", () => {
    const accepted = acceptMutation({ unchanged: true })

    expect(accepted).toEqual({ kind: "accepted", unchanged: true })
    expect(Object.isFrozen(accepted)).toBe(true)
    // @ts-expect-error — only `true` declares an empty stamp on purpose.
    acceptMutation({ unchanged: false })
  })
})

describe("command inference", () => {
  const binder = createMutationBinder({
    actor: () => "actor",
    authority: createInMemoryMutationAuthority<number, string, unknown>({
      initialState: 0,
      scope: (actor) => actor,
    }),
  })

  it("infers undefined evidence and screened values from the no-argument forms", () => {
    binder.bind(touch, {
      screen: ({ args }) => (args.id ? allowScreening() : denyMutation()),
      admit: () => allowAdmission(),
      execute: ({ evidence }) => {
        expectTypeOf(evidence).toEqualTypeOf<undefined>()
        return { kind: "accepted" }
      },
      finalizeAccepted: ({ screened }) => {
        expectTypeOf(screened).toEqualTypeOf<undefined>()
      },
    })
  })

  it("infers evidence and screened values from the forms that carry one", () => {
    binder.bind(touch, {
      screen: ({ executor }) => allowScreening({ count: executor.read() }),
      admit: ({ tx }) => allowAdmission({ observed: tx.read() }),
      execute: ({ evidence }) => {
        expectTypeOf(evidence).toEqualTypeOf<{ observed: number }>()
        return { kind: "accepted" }
      },
      finalizeAccepted: ({ screened }) => {
        expectTypeOf(screened).toEqualTypeOf<{ count: number }>()
      },
    })
  })
})
