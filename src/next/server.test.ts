import type { StandardSchemaV1 } from "@standard-schema/spec"
import { forbidden } from "next/navigation"
import { err, ok, type Result } from "serializable-result"
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest"

import { ablyAxisChannelName, ablyChannelNamespace } from "../ably/channels"
import {
  acceptedStamp,
  axisId,
  defineMutation,
  defineProtocol,
  revisionEntries,
  type AcceptedStamp,
  type InvalidationPublisher,
  type MutationAuthorityAdapter,
} from "../index"
import {
  createInMemoryMutationAuthority,
  type InMemoryReader,
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

vi.mock("next/cache", () => nextCache)

function stamp(entries: Record<string, number>): AcceptedStamp {
  const parsed = acceptedStamp({ revisions: entries })
  if (!parsed.ok) throw new Error("Invalid Next server test stamp")
  return parsed.value
}

function recordingPublisher(events: string[]): InvalidationPublisher {
  return {
    publish(eventId, accepted) {
      for (const [axis, revision] of revisionEntries(accepted.revisions)) {
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
  // Hashing bounds the tag's length and keeps it a safe tag name. The axis is
  // not confidential: hashing is not there to hide it.
  it("derives a bounded, versioned SHA-256 tag from an axis of any length", async () => {
    const axis = axisId(`entity/${"x".repeat(1_000)}`)
    const tag = await axisCacheTag(axis)

    expect(tag).toMatch(/^headcanon:axis:v1:[0-9a-f]{64}$/)
    expect(tag.length).toBeLessThanOrEqual(256)
    expect(await axisCacheTag(axis)).toBe(tag)
  })

  it("hashes an axis exactly as the Ably channel derivation does", async () => {
    const axis = axisId("entity/shared")
    const channel = await ablyAxisChannelName(
      ablyChannelNamespace("production"),
      axis
    )

    expect(await axisCacheTag(axis)).toBe(
      `headcanon:axis:v1:${channel.split(":").at(-1)}`
    )
  })

  it("parses the loader's observation and tags every axis in one call", async () => {
    const canon = await tagVersionedBase({
      value: "canon",
      revisions: { "entity/one": 1, "entity/two": 2 },
    })

    expect(canon).toEqual({
      value: "canon",
      revisions: { "entity/one": 1, "entity/two": 2 },
    })
    expect(Object.isFrozen(canon)).toBe(true)
    expect(nextCache.cacheTag).toHaveBeenCalledOnce()
    expect(nextCache.cacheTag).toHaveBeenCalledWith(
      await axisCacheTag(axisId("entity/one")),
      await axisCacheTag(axisId("entity/two"))
    )
  })

  it("rejects an invalid revision like defineCanon, before tagging", async () => {
    await expect(
      tagVersionedBase({ value: null, revisions: { "entity/one": -1 } })
    ).rejects.toThrow(
      'defineCanon received an invalid revision vector: invalid-revision-vector at axis "entity/one" (negative)'
    )
    expect(nextCache.cacheTag).not.toHaveBeenCalled()
  })

  it("fails before cacheTag can accept a partial 129-axis entry", async () => {
    const revisions = Object.fromEntries(
      Array.from({ length: MAX_VERSIONED_BASE_AXES + 1 }, (_, index) => [
        `axis/${index}`,
        index,
      ])
    )

    await expect(tagVersionedBase({ value: null, revisions })).rejects.toThrow(
      RangeError
    )
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
      `update:${await axisCacheTag(first)}`,
      `update:${await axisCacheTag(second)}`,
    ])
    expect(events[2]).toBe("refresh")
    const published = events.slice(3, 5)
    expect(published).toHaveLength(2)
    expect(published[0]?.split(":")[1]).toBe(published[1]?.split(":")[1])
  })

  it("uses immediate revalidation outside a Server Action and never refreshes", async () => {
    await announceExternalCommit(accepted, { publish: vi.fn() }, vi.fn())

    expect(nextCache.revalidateTag.mock.calls).toEqual([
      [await axisCacheTag(first), { expire: 0 }],
      [await axisCacheTag(second), { expire: 0 }],
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

    // Axis tags are hashed with WebCrypto, so expiry follows an async hop.
    await vi.waitFor(() => expect(nextCache.refresh).toHaveBeenCalledOnce())
    expect(nextCache.updateTag).toHaveBeenCalledTimes(2)
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
type CounterPreflight = InMemoryReader<number>
type CounterAuthority = MutationAuthorityAdapter<
  CounterTx,
  string,
  unknown,
  CounterPreflight
>

const stringSchema: StandardSchemaV1<unknown, { readonly value: string }> = {
  "~standard": {
    version: 1,
    vendor: "headcanon-next-server-test",
    validate(value) {
      return { value: value as { readonly value: string } }
    },
  },
}

const rename = defineMutation({
  name: "next.rename",
  args: stringSchema,
  refusal: rejectionSchema,
  predict(state: number) {
    return ok(state)
  },
})
const pairProtocol = defineProtocol({
  id: "test.next-server.pair.v1",
  mutations: [increment, rename],
})

const renameCommand: MutationCommand<
  typeof rename,
  string,
  CounterPreflight,
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
  bindMutation(increment, renameCommand)
}
void rejectMismatchedBindingsAtCompileTime

const plainIncrementCommand: MutationCommand<
  typeof increment,
  string,
  CounterPreflight,
  CounterTx,
  null,
  null
> = {
  screen: () => allowMutationScreening(null),
  admit: () => allowMutation(null),
  execute: () => acceptMutation(),
}

const numberActorIncrementCommand: MutationCommand<
  typeof increment,
  number,
  CounterPreflight,
  CounterTx,
  null,
  null
> = {
  screen: ({ actor }) => {
    void actor.toFixed()
    return allowMutationScreening(null)
  },
  admit: () => allowMutation(null),
  execute: () => acceptMutation(),
}

const counterAuthority: CounterAuthority = createInMemoryMutationAuthority<
  number,
  string,
  unknown
>({ initialState: 0, scope: (actor) => actor })
const incrementBinding = bindMutation(increment, plainIncrementCommand)
const renameBinding = bindMutation(rename, renameCommand)
const numberActorIncrementBinding = bindMutation(
  increment,
  numberActorIncrementCommand
)
const pairCommands = [incrementBinding, renameBinding] as const

/** Gives a value a declared type that control flow will not narrow. */
function typed<T>(value: T): T {
  return value
}

// Each list below is wrong for `pairProtocol`, so each must fail to compile.
// A list type that is a union, or an entry type that is a union, is checked as
// one whole: a check that split it into branches could pass every branch on
// its own and miss the one list that really runs.
function rejectInvalidCommandListsAtCompileTime() {
  const context = {
    protocol: pairProtocol,
    actor: () => "actor",
    authority: counterAuthority,
  }

  createNextMutationAction({
    ...context,
    // @ts-expect-error — increment is bound twice.
    commands: [incrementBinding, incrementBinding, renameBinding],
  })
  createNextMutationAction({
    ...context,
    // @ts-expect-error — a widened array hides its number-actor command.
    commands: [numberActorIncrementBinding, renameBinding] as Array<
      typeof numberActorIncrementBinding | typeof renameBinding
    >,
  })
  createNextMutationAction({
    ...context,
    // @ts-expect-error — a widened array is not one fixed list, even when every entry is valid.
    commands: [incrementBinding, renameBinding] as Array<
      typeof incrementBinding | typeof renameBinding
    >,
  })
  createNextMutationAction({
    ...context,
    // @ts-expect-error — the first entry may be either mutation.
    commands: [
      typed<typeof incrementBinding | typeof renameBinding>(incrementBinding),
      renameBinding,
    ],
  })
  createNextMutationAction({
    ...context,
    // @ts-expect-error — one branch of the increment entry takes a number actor.
    commands: [
      typed<typeof incrementBinding | typeof numberActorIncrementBinding>(
        incrementBinding
      ),
      renameBinding,
    ],
  })
  createNextMutationAction({
    ...context,
    // @ts-expect-error — one branch of the list binds increment twice.
    commands: typed<
      | readonly [typeof incrementBinding, typeof renameBinding]
      | readonly [typeof incrementBinding, typeof incrementBinding]
    >(pairCommands),
  })
  createNextMutationAction({
    ...context,
    // @ts-expect-error — one branch of the list takes a number actor.
    commands: typed<
      | readonly [typeof incrementBinding, typeof renameBinding]
      | readonly [typeof numberActorIncrementBinding, typeof renameBinding]
    >(pairCommands),
  })
  createNextMutationAction({
    ...context,
    // @ts-expect-error — together the branches cover the protocol; neither branch does.
    commands: typed<
      readonly [typeof incrementBinding] | readonly [typeof renameBinding]
    >([incrementBinding]),
  })
  createNextMutationAction({
    ...context,
    // @ts-expect-error — rename is not bound.
    commands: [incrementBinding],
  })
}
void rejectInvalidCommandListsAtCompileTime

describe("Next mutation action", () => {
  type IncrementCommand = MutationCommand<
    typeof increment,
    string,
    CounterPreflight,
    CounterTx,
    { readonly screened: number },
    { readonly observed: number }
  >
  type IncrementFinalization = NonNullable<IncrementCommand["finalizeAccepted"]>

  function createAuthority() {
    return createInMemoryMutationAuthority<number, string, unknown>({
      initialState: 0,
      scope: (actor) => actor,
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
      execute({ tx, args, stamp, mutationId }) {
        options.lifecycle?.push(`execute:${mutationId}`)
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
    registered: IncrementCommand = command(),
    options: {
      readonly actor?: () => string
      readonly invalidations?: InvalidationPublisher
    } = {}
  ) {
    return createNextMutationAction({
      protocol,
      actor: options.actor ?? (() => "actor"),
      authority,
      commands: [bindMutation(increment, registered)],
      invalidations: options.invalidations ?? { publish: vi.fn() },
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

    expect(lifecycle).toEqual([
      "screen:0",
      "admit:0",
      `execute:${envelope.mutationId}`,
      "admit:10",
      `execute:${envelope.mutationId}`,
    ])
    expect(authority.read()).toBe(11)
  })

  // `next/navigation` is not mocked in this file, so this observes the real
  // Next behaviour that a denial must not depend on.
  it("cannot deny through forbidden() without Next's experimental flag", () => {
    expect(process.env.__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS).toBeUndefined()
    expect(() => forbidden()).toThrow(
      "`forbidden()` is experimental and only allowed to be enabled when `experimental.authInterrupts` is enabled."
    )
  })

  it("returns a screening denial without a framework flag and claims no receipt", async () => {
    const authority = createAuthority()

    await expect(
      action(authority, command({ denyScreen: true }))(envelope)
    ).resolves.toEqual(ok({ kind: "denied" }))

    expect(authority.receiptCount()).toBe(0)
  })

  it("never derives the actor, screens, or admits for a malformed or unknown envelope", async () => {
    const authority = createAuthority()
    const lifecycle: string[] = []
    const execute = action(authority, command({ lifecycle }), {
      actor: () => {
        lifecycle.push("actor")
        return "actor"
      },
    })

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

    await expect(execute(envelope)).resolves.toEqual(ok({ kind: "denied" }))
    await expect(execute(envelope)).resolves.toEqual(ok({ kind: "denied" }))

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

    expect(first).toEqual(ok({ kind: "refused", error: { code: "refused" } }))
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

  it("runs the accepted projection before it expires, refreshes, or publishes", async () => {
    const events: string[] = []
    nextCache.updateTag.mockImplementation(() => events.push("update"))
    nextCache.refresh.mockImplementation(() => events.push("refresh"))
    const execute = action(
      createAuthority(),
      command({ finalizeAccepted: () => void events.push("project") }),
      { invalidations: { publish: () => void events.push("publish") } }
    )

    await execute(envelope)

    expect(events).toEqual(["project", "update", "refresh", "publish"])
  })

  it("still invalidates the commit when the projection throws, then rethrows", async () => {
    const events: string[] = []
    nextCache.updateTag.mockImplementation(() => events.push("update"))
    nextCache.refresh.mockImplementation(() => events.push("refresh"))
    const failure = new Error("projection unavailable")
    const authority = createAuthority()
    const execute = action(
      authority,
      command({
        finalizeAccepted: () => {
          events.push("project")
          throw failure
        },
      }),
      { invalidations: { publish: () => void events.push("publish") } }
    )

    await expect(execute(envelope)).rejects.toBe(failure)

    expect(events).toEqual(["project", "update", "refresh", "publish"])
    expect(authority.read()).toBe(1)
  })

  it("expires and refreshes without publishing when it has no realtime transport", async () => {
    const events: string[] = []
    nextCache.updateTag.mockImplementation(() => events.push("update"))
    nextCache.refresh.mockImplementation(() => events.push("refresh"))
    const execute = createNextMutationAction({
      protocol,
      actor: () => "actor",
      authority: createAuthority(),
      commands: [bindMutation(increment, command())],
    })

    await expect(execute(envelope)).resolves.toMatchObject(
      ok({ kind: "accepted" })
    )

    expect(events).toEqual(["update", "refresh"])
  })

  it("requires a publisher and its failure reporter together", () => {
    const base = {
      protocol,
      actor: () => "actor",
      authority: createAuthority(),
      commands: [bindMutation(increment, command())],
    } as const
    // @ts-expect-error — a publisher needs a reporter for its failures.
    createNextMutationAction({ ...base, invalidations: { publish: vi.fn() } })
    // @ts-expect-error — a reporter without a publisher has nothing to report.
    createNextMutationAction({ ...base, reportInvalidationFailure: vi.fn() })
  })

  // README, Drizzle section: an inline command gets `args` from its mutation
  // but no context types, so commands are declared as `MutationCommand`s. If
  // TypeScript starts inferring these, update the README.
  it("infers an inline command's args but not its context", () => {
    createNextMutationAction({
      protocol,
      actor: () => "actor",
      authority: createAuthority(),
      commands: [
        bindMutation(increment, {
          screen: ({ actor, executor, args }) => {
            expectTypeOf(actor).toBeUnknown()
            expectTypeOf(executor).toBeUnknown()
            expectTypeOf(args.amount).toBeNumber()
            return allowMutationScreening(null)
          },
          admit: ({ tx }) => {
            expectTypeOf(tx).toBeUnknown()
            return allowMutation(null)
          },
          execute: () => acceptMutation(),
        }),
      ],
    })
  })

  it("gives screening and finalization separate copies of the arguments", async () => {
    const finalizeAccepted = vi.fn()
    const registered = {
      ...command({ finalizeAccepted }),
      screen: ({ args }) => {
        ;(args as { amount: number }).amount = 99
        return allowMutationScreening({ screened: 0 })
      },
    } satisfies IncrementCommand

    await action(createAuthority(), registered)(envelope)

    expect(finalizeAccepted).toHaveBeenCalledWith(
      expect.objectContaining({ args: { amount: 1 } })
    )
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
    const authority: CounterAuthority = {
      preflight: { read: () => 0 },
      async execute(request) {
        request.parseRefusal?.({ code: "corrupt" })
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
        // @ts-expect-error — the compiler rejects the duplicate too; this checks the runtime guard.
        commands: [
          bindMutation(increment, registered),
          bindMutation(increment, registered),
        ],
        invalidations: { publish: vi.fn() },
        reportInvalidationFailure: vi.fn(),
      })
    ).toThrow("Duplicate mutation binding: next.increment")
  })

  it("accepts an inline list and an `as const` list declared elsewhere", () => {
    const context = {
      protocol: pairProtocol,
      actor: () => "actor",
      authority: counterAuthority,
    }

    expect(() =>
      createNextMutationAction({
        ...context,
        commands: [incrementBinding, renameBinding],
      })
    ).not.toThrow()
    expect(() =>
      createNextMutationAction({ ...context, commands: pairCommands })
    ).not.toThrow()
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
