import type { StandardSchemaV1 } from "@standard-schema/spec"
import { err, ok } from "serializable-result"
import { describe, expect, it } from "vitest"

import { createDrizzleMutationAuthority } from "../drizzle/index"
import {
  axisId,
  createStampAccumulator,
  defineMutation,
  defineProtocol,
} from "../index"
import { createInMemoryMutationAuthority } from "../testing/index"
import { prepareMutationRequest } from "./authority"

const amountSchema: StandardSchemaV1<unknown, { readonly amount: number }> = {
  "~standard": {
    version: 1,
    vendor: "headcanon-authority-test",
    validate(value) {
      return { value: value as { readonly amount: number } }
    },
  },
}
const add = defineMutation({
  name: "authority.add",
  args: amountSchema,
  predict(state: number, args) {
    return ok(state + args.amount)
  },
})
const protocol = defineProtocol({ id: "test.authority.v1", mutations: [add] })

describe("envelope admission", () => {
  it("rejects client revision claims outside the admitted envelope", async () => {
    await expect(
      prepareMutationRequest(protocol, {
        protocol: protocol.id,
        mutationId: "30000000-0000-4000-8000-000000000001",
        invocation: add({ amount: 1 }),
        expectedRevision: 0,
      })
    ).resolves.toEqual(
      err({ code: "invalid-envelope", reason: "unexpected-fields" })
    )
  })
})

describe("authority retry policy", () => {
  it.each([0, 1.5, Number.NaN])(
    "rejects maxAttempts %s in every adapter",
    (maxAttempts) => {
      expect(() =>
        createInMemoryMutationAuthority({
          initialState: 0,
          scope: (actor: string) => actor,
          maxAttempts,
        })
      ).toThrow("maxAttempts must be a positive integer")
      expect(() =>
        createDrizzleMutationAuthority({
          db: {} as never,
          scope: (actor: string) => actor,
          maxAttempts,
        })
      ).toThrow("maxAttempts must be a positive integer")
    }
  )
})

describe("stamp accumulator", () => {
  it("owns raw revision validation and returns branded accepted stamps", () => {
    const stamp = createStampAccumulator()

    stamp.record(axisId("entity/one"), 2)

    const accepted = stamp.accepted()
    expect(accepted).toEqual({
      revisions: { "entity/one": 2 },
    })
    expect(Object.isFrozen(accepted)).toBe(true)
    expect(Object.isFrozen(accepted.revisions)).toBe(true)
    expect(() => stamp.record(axisId("entity/two"), Number.NaN)).toThrow(
      "Invalid stamped revision for axis: entity/two"
    )
  })

  it("rejects regression on an axis while accepting equal redelivery", () => {
    const stamp = createStampAccumulator()
    const axis = axisId("entity/one")

    stamp.record(axis, 2)
    stamp.record(axis, 2)

    expect(() => stamp.record(axis, 1)).toThrow(
      "Revision regressed while stamping axis: entity/one"
    )
  })
})
