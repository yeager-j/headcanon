import type { StandardSchemaV1 } from "@standard-schema/spec"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { err, ok, type Result } from "@workspace/result"

import {
  acceptedStamp,
  axisId,
  defineMutation,
  defineProtocol,
  revisionVector,
  type AcceptedStamp,
  type InvalidationPublisher,
  type MutationAuthorityAdapter,
} from "../index"
import {
  createInMemoryMutationAuthority,
  type InMemoryTransaction,
} from "../testing"
import {
  acceptMutation,
  allowMutation,
  allowMutationScreening,
  announceExternalCommit,
  axisCacheTag,
  bindMutation,
  createNextMutationAction,
  denyMutation,
  finalizeExternalActionCommit,
  MAX_VERSIONED_BASE_AXES,
  refuseMutation,
  tagVersionedBase,
  type MutationCommand,
} from "./server"

const nextCache = vi.hoisted(() => ({
  cacheTag: vi.fn(),
  refresh: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
}))
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("forbidden")
  })
)

vi.mock("next/cache", () => nextCache)
vi.mock("next/navigation", () => ({ forbidden }))

function stamp(entries: Record<string, number>): AcceptedStamp {
  const revisions = revisionVector(entries)
  if (!revisions.ok) throw new Error("Invalid Next server test stamp")
  return acceptedStamp(revisions.value)
}

function recordingPublisher(events: string[]): InvalidationPublisher {
  return {
    publish(eventId, accepted) {
      for (const [axis, revision] of Object.entries(accepted.revisions)) {
        events.push(`publish:${eventId}:${axis}:${revision}`)
      }
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("axis cache tags", () => {
  it("derives a bounded, versioned SHA-256 tag without exposing the axis", () => {
    const axis = axisId(`secret/${"x".repeat(1_000)}`)
    const tag = axisCacheTag(axis)

    expect(tag).toMatch(/^headcanon:axis:v1:[0-9a-f]{64}$/)
    expect(tag.length).toBeLessThanOrEqual(256)
    expect(tag).not.toContain(axis)
    expect(axisCacheTag(axis)).toBe(tag)
  })

  it("tags every observed axis in one cacheTag call and preserves identity", () => {
    const base = {
      value: "canon",
      revisions: stamp({ "entity/one": 1, "entity/two": 2 }).revisions,
    }

    expect(tagVersionedBase(base)).toBe(base)
    expect(nextCache.cacheTag).toHaveBeenCalledOnce()
    expect(nextCache.cacheTag).toHaveBeenCalledWith(
      axisCacheTag(axisId("entity/one")),
      axisCacheTag(axisId("entity/two"))
    )
  })

  it("fails before cacheTag can accept a partial 129-axis entry", () => {
    const revisions = Object.fromEntries(
      Array.from({ length: MAX_VERSIONED_BASE_AXES + 1 }, (_, index) => [
        `axis/${index}`,
        index,
      ])
    )
    const base = { value: null, revisions: stamp(revisions).revisions }

    expect(() => tagVersionedBase(base)).toThrow(RangeError)
    expect(nextCache.cacheTag).not.toHaveBeenCalled()
  })
})

describe("Next commit finalization", () => {
  const first = axisId("entity/first")
  const second = axisId("entity/second")
  const accepted = stamp({ [first]: 3, [second]: 5 })

  it("expires every axis, refreshes, then publishes one shared event", async () => {
    const events: string[] = []
    nextCache.updateTag.mockImplementation((tag) => {
      events.push(`update:${tag}`)
    })
    nextCache.refresh.mockImplementation(() => {
      events.push("refresh")
    })

    await finalizeExternalActionCommit(
      accepted,
      recordingPublisher(events),
      vi.fn()
    )

    expect(events.slice(0, 2)).toEqual([
      `update:${axisCacheTag(first)}`,
      `update:${axisCacheTag(second)}`,
    ])
    expect(events[2]).toBe("refresh")
    const published = events.slice(3, 5)
    expect(published).toHaveLength(2)
    expect(published[0]?.split(":")[1]).toBe(published[1]?.split(":")[1])
  })

  it("uses immediate revalidation outside a Server Action and never refreshes", async () => {
    await announceExternalCommit(accepted, { publish: vi.fn() }, vi.fn())

    expect(nextCache.revalidateTag.mock.calls).toEqual([
      [axisCacheTag(first), { expire: 0 }],
      [axisCacheTag(second), { expire: 0 }],
    ])
    expect(nextCache.updateTag).not.toHaveBeenCalled()
    expect(nextCache.refresh).not.toHaveBeenCalled()
  })

  it("keeps publication failure advisory and still refreshes the invoking route", async () => {
    const reportFailure = vi.fn()
    const error = new Error("realtime unavailable")
    await expect(
      finalizeExternalActionCommit(
        accepted,
        {
          publish: async () => {
            throw error
          },
        },
        reportFailure
      )
    ).resolves.toBeUndefined()

    expect(nextCache.updateTag).toHaveBeenCalledTimes(2)
    expect(nextCache.refresh).toHaveBeenCalledOnce()
    expect(reportFailure).toHaveBeenCalledExactlyOnceWith({
      kind: "rejected",
      eventId: expect.any(String),
      stamp: accepted,
      error,
    })

    await expect(
      finalizeExternalActionCommit(
        accepted,
        { publish: async () => Promise.reject(error) },
        () => {
          throw new Error("diagnostics unavailable")
        }
      )
    ).resolves.toBeUndefined()
  })

  it("bounds stalled advisory publication after refreshing the route", async () => {
    vi.useFakeTimers()
    const reportFailure = vi.fn()
    const finalization = finalizeExternalActionCommit(
      accepted,
      {
        publish: () => new Promise<void>(() => undefined),
      },
      reportFailure
    )
    const settled = vi.fn()
    void finalization.then(settled)

    expect(nextCache.updateTag).toHaveBeenCalledTimes(2)
    expect(nextCache.refresh).toHaveBeenCalledOnce()
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()

    await vi.runAllTimersAsync()

    await expect(finalization).resolves.toBeUndefined()
    expect(settled).toHaveBeenCalledOnce()
    expect(reportFailure).toHaveBeenCalledExactlyOnceWith({
      kind: "timed-out",
      eventId: expect.any(String),
      stamp: accepted,
    })
  })
})

type IncrementArgs = { readonly amount: number }
type Rejection = { readonly code: "refused" }

const incrementSchema: StandardSchemaV1<unknown, IncrementArgs> = {
  "~standard": {
    version: 1,
    vendor: "headcanon-next-server-test",
    validate(value) {
      return { value: value as IncrementArgs }
    },
  },
}

const rejectionSchema: StandardSchemaV1<unknown, Rejection> = {
  "~standard": {
    version: 1,
    vendor: "headcanon-next-server-test",
    validate(value) {
      if (
        typeof value === "object" &&
        value !== null &&
        "code" in value &&
        value.code === "refused"
      ) {
        return { value: { code: "refused" as const } }
      }
      return { issues: [{ message: "Expected a refusal" }] }
    },
  },
}

const increment = defineMutation({
  name: "next.increment",
  args: incrementSchema,
  refusal: rejectionSchema,
  predict(state: number, args): Result<number, Rejection> {
    return ok(state + args.amount)
  },
})
const protocol = defineProtocol({
  id: "test.next-server.v1",
  mutations: [increment],
})

type CounterTx = InMemoryTransaction<number>
type CounterAuthority = MutationAuthorityAdapter<
  CounterTx,
  string,
  unknown,
  CounterTx
> & { readonly preflight: CounterTx }

const stringSchema: StandardSchemaV1<unknown, { readonly value: string }> = {
  "~standard": {
    version: 1,
    vendor: "headcanon-next-server-test",
    validate(value) {
      return { value: value as { readonly value: string } }
    },
  },
}

const _rename = defineMutation({
  name: "next.rename",
  args: stringSchema,
  refusal: rejectionSchema,
  predict(state: number) {
    return ok(state)
  },
})

const wrongArgsCommand: MutationCommand<
  typeof _rename,
  string,
  CounterTx,
  CounterTx,
  undefined,
  undefined
> = {
  screen: ({ args }) => {
    void args.value
    return allowMutationScreening(undefined)
  },
  admit: ({ args }) => {
    void args.value
    return allowMutation(undefined)
  },
  execute: ({ args }) => {
    void args.value
    return acceptMutation()
  },
}

function rejectMismatchedBindingsAtCompileTime() {
  // @ts-expect-error — the command accepts next.rename args, not increment args.
  bindMutation(increment, wrongArgsCommand)
}
void rejectMismatchedBindingsAtCompileTime

describe("Next mutation action", () => {
  type IncrementCommand = MutationCommand<
    typeof increment,
    string,
    CounterTx,
    CounterTx,
    { readonly screened: number },
    { readonly observed: number }
  >
  type IncrementFinalization = NonNullable<IncrementCommand["finalizeAccepted"]>

  function createAuthority() {
    const authority = createInMemoryMutationAuthority<number, string, unknown>({
      initialState: 0,
      scope: (actor) => actor,
    })
    return Object.assign(authority, {
      preflight: {
        read: () => authority.read(),
        write: (next: number) => authority.replace(next),
      } satisfies CounterTx,
    })
  }

  function command(
    options: {
      readonly lifecycle?: string[]
      readonly finalizeAccepted?: IncrementFinalization
      readonly denyScreen?: boolean
    } = {}
  ): IncrementCommand {
    return {
      screen({ executor }) {
        options.lifecycle?.push(`screen:${executor.read()}`)
        return options.denyScreen
          ? denyMutation()
          : allowMutationScreening({ screened: executor.read() })
      },
      admit({ tx }) {
        options.lifecycle?.push(`admit:${tx.read()}`)
        return allowMutation({ observed: tx.read() })
      },
      execute({ tx, args, stamp }) {
        if (args.amount < 0) return refuseMutation({ code: "refused" } as const)
        const next = tx.read() + args.amount
        tx.write(next)
        stamp.record(axisId("counter/value"), next)
        return acceptMutation()
      },
      finalizeAccepted: options.finalizeAccepted,
    } satisfies IncrementCommand
  }

  function action(
    authority: CounterAuthority,
    registered: IncrementCommand = command()
  ) {
    return createNextMutationAction({
      protocol,
      actor: () => "actor",
      authority,
      commands: [bindMutation(increment, registered)],
      invalidations: { publish: vi.fn() },
      reportInvalidationFailure: vi.fn(),
    })
  }

  const envelope = {
    protocol: protocol.id,
    mutationId: "83da9d18-9796-44b6-8bc1-066d9ca24fbb",
    invocation: increment({ amount: 1 }),
  }

  it("screens before receipt ownership and admits on every contention attempt", async () => {
    const authority = createAuthority()
    const lifecycle: string[] = []
    authority.contendNext((current) => current + 10)

    await action(authority, command({ lifecycle }))(envelope)

    expect(lifecycle).toEqual(["screen:0", "admit:0", "admit:10"])
    expect(authority.read()).toBe(11)
    expect(authority.attemptCount("actor", envelope.mutationId)).toBe(2)
  })

  it("claims no receipt when screening denies", async () => {
    const authority = createAuthority()

    await expect(
      action(authority, command({ denyScreen: true }))(envelope)
    ).rejects.toThrow("forbidden")

    expect(authority.receiptCount()).toBe(0)
  })

  it("never screens or admits a malformed or unknown envelope", async () => {
    const authority = createAuthority()
    const lifecycle: string[] = []
    const execute = action(authority, command({ lifecycle }))

    await expect(execute({ bad: true })).resolves.toEqual(
      err({ code: "invalid-envelope", reason: "unexpected-fields" })
    )
    await expect(
      execute({
        ...envelope,
        invocation: { name: "next.unknown", args: { amount: 1 } },
      })
    ).resolves.toEqual(
      err({ code: "invalid-envelope", reason: "unknown-mutation" })
    )

    expect(lifecycle).toEqual([])
    expect(authority.receiptCount()).toBe(0)
  })

  it("records transaction-time denial privately and recovers it on redelivery", async () => {
    const authority = createAuthority()
    let transactionAdmissions = 0
    const registered = {
      screen: ({ executor }) =>
        allowMutationScreening({ screened: executor.read() }),
      admit() {
        transactionAdmissions += 1
        return denyMutation()
      },
      execute: () => acceptMutation(),
    } satisfies IncrementCommand
    const execute = action(authority, registered)

    await expect(execute(envelope)).rejects.toThrow("forbidden")
    await expect(execute(envelope)).rejects.toThrow("forbidden")

    expect(authority.receiptCount()).toBe(1)
    expect(authority.read()).toBe(0)
    expect(transactionAdmissions).toBe(1)
  })

  it("preserves a structured refusal across same-ID recovery", async () => {
    const authority = createAuthority()
    const execute = action(authority)
    const refusedEnvelope = {
      ...envelope,
      invocation: increment({ amount: -1 }),
    }

    const first = await execute(refusedEnvelope)
    const duplicate = await execute(refusedEnvelope)

    expect(first).toEqual(ok({ kind: "rejected", error: { code: "refused" } }))
    expect(duplicate).toEqual(first)
    expect(authority.receiptCount()).toBe(1)
  })

  it("reruns repeat-safe finalization for duplicate accepted recovery", async () => {
    const authority = createAuthority()
    const finalizeAccepted = vi.fn()
    const execute = action(authority, command({ finalizeAccepted }))

    const first = await execute(envelope)
    const duplicate = await execute(envelope)

    expect(duplicate).toEqual(first)
    expect(finalizeAccepted).toHaveBeenCalledTimes(2)
    expect(authority.read()).toBe(1)
  })

  it("passes screening projection, never attempt evidence, to finalization", async () => {
    const authority = createAuthority()
    const finalizeAccepted = vi.fn()
    const execute = action(authority, command({ finalizeAccepted }))

    await execute(envelope)

    expect(finalizeAccepted).toHaveBeenCalledWith(
      expect.objectContaining({
        projection: { screened: 0 },
      })
    )
    expect(finalizeAccepted.mock.calls[0]![0]).not.toHaveProperty("evidence")
    expect(finalizeAccepted.mock.calls[0]![0]).not.toHaveProperty("preflight")
  })

  it("accepts a three-axis command without another interface field", async () => {
    const authority = createAuthority()
    const registered: IncrementCommand = {
      screen: ({ executor }) =>
        allowMutationScreening({ screened: executor.read() }),
      admit: ({ tx }) => allowMutation({ observed: tx.read() }),
      execute: ({ tx, args, stamp }) => {
        tx.write(tx.read() + args.amount)
        for (const [name, value] of [
          ["counter/first", 1],
          ["counter/second", 2],
          ["counter/third", 3],
        ] as const) {
          stamp.record(axisId(name), value)
        }
        return acceptMutation()
      },
    }

    const result = await action(authority, registered)(envelope)

    expect(result).toEqual(
      ok({
        kind: "accepted",
        stamp: {
          revisions: {
            "counter/first": 1,
            "counter/second": 2,
            "counter/third": 3,
          },
        },
      })
    )
  })

  it("does not finalize a public refusal", async () => {
    const authority = createAuthority()
    const finalizeAccepted = vi.fn()
    const execute = action(authority, command({ finalizeAccepted }))

    await execute({ ...envelope, invocation: increment({ amount: -1 }) })

    expect(finalizeAccepted).not.toHaveBeenCalled()
  })

  it("fails closed when the authority presents a corrupt stored refusal", async () => {
    const preflight: CounterTx = { read: () => 0, write: vi.fn() }
    const authority: MutationAuthorityAdapter<
      CounterTx,
      string,
      unknown,
      CounterTx
    > & { readonly preflight: CounterTx } = {
      preflight,
      async execute(request) {
        request.parseRejection?.({ code: "corrupt" })
        throw new Error("corrupt refusal was admitted")
      },
    }

    await expect(action(authority)(envelope)).rejects.toThrow(
      "Invalid stored mutation refusal"
    )
  })

  it("rejects duplicate command registration at construction", () => {
    const authority = createAuthority()
    const registered = command()

    expect(() =>
      createNextMutationAction({
        protocol,
        actor: () => "actor",
        authority,
        commands: [
          bindMutation(increment, registered),
          bindMutation(increment, registered),
        ],
        invalidations: { publish: vi.fn() },
        reportInvalidationFailure: vi.fn(),
      })
    ).toThrow("Duplicate mutation binding: next.increment")
  })

  it("rejects missing command registration at construction", () => {
    expect(() =>
      createNextMutationAction({
        protocol,
        actor: () => "actor",
        authority: createAuthority(),
        commands: [] as never,
        invalidations: { publish: vi.fn() },
        reportInvalidationFailure: vi.fn(),
      })
    ).toThrow("Incomplete mutation bindings: missing [next.increment]")
  })
})
