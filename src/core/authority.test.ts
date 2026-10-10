import type { StandardSchemaV1 } from "@standard-schema/spec"
import { err, ok } from "serializable-result"
import { describe, expect, it } from "vitest"

import { axisId, defineMutation, defineProtocol } from ".."
import { createDrizzleMutationAuthority } from "../drizzle"
import { createInMemoryMutationAuthority } from "../testing"
import {
  checkDeliveryAge,
  createStampAccumulator,
  DEFAULT_CLOCK_SKEW_TOLERANCE_MS,
  DEFAULT_MAX_DELIVERY_AGE_MS,
  deliveryAgePolicy,
  executePreparedMutation,
  prepareMutationRequest,
  receiptRetentionMs,
  type MutationAcceptance,
  type StampAccumulator,
} from "./authority"

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
        scope: "actor",
        mutationId: "30000000-0000-4000-8000-000000000001",
        createdAt: Date.now(),
        invocation: add({ amount: 1 }),
        expectedRevision: 0,
      })
    ).resolves.toEqual(
      err({ code: "invalid-envelope", reason: "unexpected-fields" })
    )
  })

  it("rejects an envelope without a creation time as an old client's shape", async () => {
    await expect(
      prepareMutationRequest(protocol, {
        protocol: protocol.id,
        scope: "actor",
        mutationId: "30000000-0000-4000-8000-000000000002",
        invocation: add({ amount: 1 }),
      })
    ).resolves.toEqual(
      err({ code: "invalid-envelope", reason: "unexpected-fields" })
    )
  })

  it.each(["1", -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, null])(
    "rejects creation time %s",
    async (createdAt) => {
      await expect(
        prepareMutationRequest(protocol, {
          protocol: protocol.id,
          scope: "actor",
          mutationId: "30000000-0000-4000-8000-000000000003",
          createdAt,
          invocation: add({ amount: 1 }),
        })
      ).resolves.toEqual(
        err({ code: "invalid-envelope", reason: "invalid-created-at" })
      )
    }
  )

  it("carries the creation time into the prepared request", async () => {
    const prepared = await prepareMutationRequest(protocol, {
      protocol: protocol.id,
      scope: "actor",
      mutationId: "30000000-0000-4000-8000-000000000004",
      createdAt: 1_700_000_000_000,
      invocation: add({ amount: 1 }),
    })

    expect(prepared).toMatchObject({
      ok: true,
      value: { createdAt: 1_700_000_000_000 },
    })
  })
})

describe("delivery window", () => {
  const policy = deliveryAgePolicy({
    maxDeliveryAgeMs: 1000,
    clockSkewToleranceMs: 100,
  })
  const now = 1_700_000_000_000
  const at = (createdAt: number) =>
    checkDeliveryAge(policy, { mutationId: "m", createdAt }, now)

  it("admits both edges of the window", () => {
    expect(at(now - 1000)).toEqual(ok(undefined))
    expect(at(now + 100)).toEqual(ok(undefined))
  })

  it("refuses one millisecond past either edge", () => {
    expect(at(now - 1001)).toEqual(
      err({ code: "delivery-expired", mutationId: "m" })
    )
    expect(at(now + 101)).toEqual(
      err({ code: "delivery-from-future", mutationId: "m" })
    )
  })

  it("defaults to a 7-day age and a 1-hour skew tolerance", () => {
    expect(deliveryAgePolicy({})).toEqual({
      maxDeliveryAgeMs: DEFAULT_MAX_DELIVERY_AGE_MS,
      clockSkewToleranceMs: DEFAULT_CLOCK_SKEW_TOLERANCE_MS,
    })
    expect(DEFAULT_MAX_DELIVERY_AGE_MS).toBe(7 * 24 * 60 * 60 * 1000)
    expect(DEFAULT_CLOCK_SKEW_TOLERANCE_MS).toBe(60 * 60 * 1000)
  })

  it("keeps receipts for the age, the skew tolerance, and the margin", () => {
    expect(receiptRetentionMs(policy, 10)).toBe(1110)
    expect(() => receiptRetentionMs(policy, -1)).toThrow(
      "marginMs must be a non-negative safe integer"
    )
    expect(() => receiptRetentionMs(policy, 0.5)).toThrow(
      "marginMs must be a non-negative safe integer"
    )
  })

  it.each([0, -1, 1.5, Number.NaN])(
    "rejects maxDeliveryAgeMs %s in every adapter",
    (maxDeliveryAgeMs) => {
      const message = "maxDeliveryAgeMs must be a positive safe integer"
      expect(() => deliveryAgePolicy({ maxDeliveryAgeMs })).toThrow(message)
      expect(() =>
        createInMemoryMutationAuthority({
          initialState: 0,
          scope: (actor: string) => actor,
          maxDeliveryAgeMs,
        })
      ).toThrow(message)
      expect(() =>
        createDrizzleMutationAuthority({
          db: {} as never,
          scope: (actor: string) => actor,
          maxDeliveryAgeMs,
        })
      ).toThrow(message)
    }
  )

  it.each([-1, 1.5, Number.NaN])(
    "rejects clockSkewToleranceMs %s in every adapter",
    (clockSkewToleranceMs) => {
      const message = "clockSkewToleranceMs must be a non-negative safe integer"
      expect(() => deliveryAgePolicy({ clockSkewToleranceMs })).toThrow(message)
      expect(() =>
        createInMemoryMutationAuthority({
          initialState: 0,
          scope: (actor: string) => actor,
          clockSkewToleranceMs,
        })
      ).toThrow(message)
      expect(() =>
        createDrizzleMutationAuthority({
          db: {} as never,
          scope: (actor: string) => actor,
          clockSkewToleranceMs,
        })
      ).toThrow(message)
    }
  )
})

describe("Drizzle receipt cleanup options", () => {
  const authority = createDrizzleMutationAuthority({
    db: {} as never,
    scope: (actor: string) => actor,
  })

  it.each([0, -1, 1.5])("rejects limit %s before it queries", async (limit) => {
    await expect(authority.deleteExpiredReceipts({ limit })).rejects.toThrow(
      "limit must be a positive safe integer"
    )
  })

  it.each([-1, 1.5])(
    "rejects marginMs %s before it queries",
    async (marginMs) => {
      await expect(
        authority.deleteExpiredReceipts({ marginMs })
      ).rejects.toThrow("marginMs must be a non-negative safe integer")
    }
  )
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

describe("accepted stamp check", () => {
  const counterAxis = axisId("authority/counter")

  async function acceptWith(
    sequence: number,
    accept: (stamp: StampAccumulator) => MutationAcceptance
  ) {
    const authority = createInMemoryMutationAuthority<number, string, never>({
      initialState: 0,
      scope: (actor) => actor,
    })
    const prepared = await prepareMutationRequest(protocol, {
      protocol: protocol.id,
      scope: "actor",
      mutationId: `30000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`,
      createdAt: Date.now(),
      invocation: add({ amount: 1 }),
    })
    if (!prepared.ok) throw new Error("Invalid stamp check envelope")

    const outcome = executePreparedMutation({
      prepared: prepared.value,
      actor: "actor",
      authority,
      async run(tx, stamp) {
        tx.write(tx.read() + 1)
        return accept(stamp)
      },
    })
    return { authority, outcome }
  }

  it("throws for an acceptance with an empty stamp and records nothing", async () => {
    const { authority, outcome } = await acceptWith(10, () => ({
      kind: "accepted",
    }))

    await expect(outcome).rejects.toThrow(
      "Mutation authority.add accepted with an empty stamp. Call stamp.record(axis, revision) for each axis it advances, or return acceptMutation({ unchanged: true }) when it changes nothing."
    )
    expect(authority.read()).toBe(0)
    expect(authority.receiptCount()).toBe(0)
  })

  it("throws for an unchanged acceptance that recorded a revision", async () => {
    const { authority, outcome } = await acceptWith(11, (stamp) => {
      stamp.record(counterAxis, 1)
      return { kind: "accepted", unchanged: true }
    })

    await expect(outcome).rejects.toThrow(
      "Mutation authority.add accepted as unchanged but recorded a revision"
    )
    expect(authority.read()).toBe(0)
    expect(authority.receiptCount()).toBe(0)
  })

  it("accepts an unchanged acceptance with an empty stamp", async () => {
    const { outcome } = await acceptWith(12, () => ({
      kind: "accepted",
      unchanged: true,
    }))

    await expect(outcome).resolves.toEqual(
      ok({ kind: "accepted", stamp: { revisions: {} } })
    )
  })

  it("accepts a stamped acceptance", async () => {
    const { outcome } = await acceptWith(13, (stamp) => {
      stamp.record(counterAxis, 1)
      return { kind: "accepted" }
    })

    await expect(outcome).resolves.toEqual(
      ok({ kind: "accepted", stamp: { revisions: { [counterAxis]: 1 } } })
    )
  })
})
