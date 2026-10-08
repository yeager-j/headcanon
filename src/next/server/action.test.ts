import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { NodePgDatabase } from "drizzle-orm/node-postgres"
import { pgTable, text } from "drizzle-orm/pg-core"
import { forbidden } from "next/navigation"
import { err, ok, type Result } from "serializable-result"
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest"

import { createNextMutationAction } from "."
import {
  axisId,
  defineMutation,
  defineProtocol,
  type InvalidationPublisher,
} from "../.."
import type { MutationAuthorityAdapter } from "../../core/authority"
import {
  createDrizzleMutationAuthority,
  type DrizzleMutationTx,
} from "../../drizzle"
import {
  acceptMutation,
  allowAdmission,
  allowScreening,
  createMutationBinder,
  denyMutation,
  refuseMutation,
  type MutationBinder,
  type MutationCommand,
} from "../../server"
import {
  createInMemoryMutationAuthority,
  type InMemoryReader,
  type InMemoryTransaction,
} from "../../testing"

const nextCache = vi.hoisted(() => ({
  cacheTag: vi.fn(),
  refresh: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
}))

vi.mock("next/cache", () => nextCache)

beforeEach(() => {
  vi.clearAllMocks()
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
    expectTypeOf(args).toEqualTypeOf<{ readonly value: string }>()
    return allowScreening()
  },
  admit: ({ args }) => {
    expectTypeOf(args).toEqualTypeOf<{ readonly value: string }>()
    return allowAdmission()
  },
  execute: ({ args }) => {
    expectTypeOf(args).toEqualTypeOf<{ readonly value: string }>()
    return acceptMutation()
  },
}

const plainIncrementCommand: MutationCommand<
  typeof increment,
  string,
  CounterPreflight,
  CounterTx,
  undefined,
  undefined
> = {
  screen: () => allowScreening(),
  admit: () => allowAdmission(),
  execute: () => acceptMutation(),
}

const numberActorIncrementCommand: MutationCommand<
  typeof increment,
  number,
  CounterPreflight,
  CounterTx,
  undefined,
  undefined
> = {
  screen: ({ actor }) => {
    expectTypeOf(actor).toEqualTypeOf<number>()
    return allowScreening()
  },
  admit: () => allowAdmission(),
  execute: () => acceptMutation(),
}

const counterAuthority: CounterAuthority = createInMemoryMutationAuthority<
  number,
  string,
  unknown
>({ initialState: 0, scope: (actor) => actor })
const counterBinder = createMutationBinder({
  actor: () => "actor",
  authority: counterAuthority,
})
const numberActorBinder = createMutationBinder({
  actor: () => 0,
  authority: createInMemoryMutationAuthority<number, number, unknown>({
    initialState: 0,
    scope: String,
  }),
})
const incrementBinding = counterBinder.bind(increment, plainIncrementCommand)
const renameBinding = counterBinder.bind(rename, renameCommand)
const numberActorIncrementBinding = numberActorBinder.bind(
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
  const context = { protocol: pairProtocol, binder: counterBinder }

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

function rejectMismatchedBindingsAtCompileTime() {
  // @ts-expect-error — the command accepts next.rename args, not increment args.
  counterBinder.bind(increment, renameCommand)

  const textBinding = createMutationBinder({
    actor: () => "actor",
    authority: createInMemoryMutationAuthority<string, string, unknown>({
      initialState: "",
      scope: (actor) => actor,
    }),
  }).bind(increment, {
    screen: () => allowScreening(),
    admit: () => allowAdmission(),
    execute: () => acceptMutation(),
  })
  createNextMutationAction({
    protocol,
    binder: counterBinder,
    // @ts-expect-error — the binding's command runs in a text transaction, not a counter one.
    commands: [textBinding],
  })
}
void rejectMismatchedBindingsAtCompileTime

interface User {
  readonly id: string
}
interface Tenant {
  readonly id: string
  readonly tenantId: string
}

function counterAuthorityFor<Actor>(scope: (actor: Actor) => string) {
  return createInMemoryMutationAuthority<number, Actor, unknown>({
    initialState: 0,
    scope,
  })
}

// The actor type comes from the `actor` callback alone. An authority whose
// actor type does not accept every actor the callback returns is rejected on
// `authority`, even though the adapter's method parameter would let a plain
// assignment through.
function rejectAuthoritiesThatCannotAcceptTheActorAtCompileTime() {
  const tenantAuthority = counterAuthorityFor((actor: Tenant) => actor.tenantId)

  createMutationBinder({
    actor: (): User => ({ id: "user" }),
    // @ts-expect-error — the authority's scope reads tenantId, which a User lacks.
    authority: tenantAuthority,
  })
  createMutationBinder({
    actor: (): Tenant | User => ({ id: "user" }),
    // @ts-expect-error — the User member lacks the tenantId the authority reads.
    authority: tenantAuthority,
  })
  createMutationBinder({
    actor: (): User => ({ id: "user" }),
    // @ts-expect-error — the authority takes a numeric actor.
    authority: counterAuthorityFor((actor: number) => actor.toFixed()),
  })
}
void rejectAuthoritiesThatCannotAcceptTheActorAtCompileTime

const notes = pgTable("notes", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
})
type NotesDatabase = NodePgDatabase<{ readonly notes: typeof notes }>

// Type-only: no database is reached, because nothing calls this.
function inferDrizzleContextAtCompileTime(db: NotesDatabase) {
  const authority = createDrizzleMutationAuthority({
    db,
    scope: (actor: User) => actor.id,
  })
  const binder = createMutationBinder({
    actor: async (): Promise<User> => ({ id: "user" }),
    authority,
  })
  binder.bind(increment, {
    screen: async ({ actor, executor }) => {
      expectTypeOf(actor).toEqualTypeOf<User>()
      expectTypeOf(executor).toEqualTypeOf<(typeof authority)["preflight"]>()
      await executor.query.notes.findFirst()
      return allowScreening()
    },
    admit: async ({ tx, args }) => {
      expectTypeOf(tx).toEqualTypeOf<DrizzleMutationTx<NotesDatabase>>()
      await tx.insert(notes).values({ id: "note", title: `${args.amount}` })
      return allowAdmission()
    },
    execute: () => acceptMutation(),
  })

  const tenantAuthority = createDrizzleMutationAuthority({
    db,
    scope: (actor: Tenant) => actor.tenantId,
  })
  createMutationBinder({
    actor: (): User => ({ id: "user" }),
    // @ts-expect-error — the authority's scope reads tenantId, which a User lacks.
    authority: tenantAuthority,
  })
}
void inferDrizzleContextAtCompileTime

describe("Next mutation action", () => {
  type IncrementCommand = MutationCommand<
    typeof increment,
    string,
    CounterPreflight,
    CounterTx,
    { readonly count: number },
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
          : allowScreening({ count: executor.read() })
      },
      admit({ tx }) {
        options.lifecycle?.push(`admit:${tx.read()}`)
        return allowAdmission({ observed: tx.read() })
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
    const binder = createMutationBinder({
      actor: options.actor ?? (() => "actor"),
      authority,
    })
    return createNextMutationAction({
      protocol,
      binder,
      commands: [binder.bind(increment, registered)],
      invalidations: options.invalidations ?? {
        publish: vi.fn(),
        onFailure: vi.fn(),
      },
    })
  }

  const envelope = {
    protocol: protocol.id,
    mutationId: "83da9d18-9796-44b6-8bc1-066d9ca24fbb",
    createdAt: Date.now(),
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

  it("screens an expired envelope, then returns delivery-expired without admitting or recording it", async () => {
    const authority = createAuthority()
    const lifecycle: string[] = []
    const expired = {
      ...envelope,
      createdAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
    }

    await expect(
      action(authority, command({ lifecycle }))(expired)
    ).resolves.toEqual(
      err({ code: "delivery-expired", mutationId: envelope.mutationId })
    )

    expect(lifecycle).toEqual(["screen:0"])
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
      screen: ({ executor }) => allowScreening({ count: executor.read() }),
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

  it("passes the screened value, never attempt evidence, to finalization", async () => {
    const authority = createAuthority()
    const finalizeAccepted = vi.fn()
    const execute = action(authority, command({ finalizeAccepted }))

    await execute(envelope)

    expect(finalizeAccepted).toHaveBeenCalledWith(
      expect.objectContaining({
        screened: { count: 0 },
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
      {
        invalidations: {
          publish: () => void events.push("publish"),
          onFailure: vi.fn(),
        },
      }
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
      {
        invalidations: {
          publish: () => void events.push("publish"),
          onFailure: vi.fn(),
        },
      }
    )

    await expect(execute(envelope)).rejects.toBe(failure)

    expect(events).toEqual(["project", "update", "refresh", "publish"])
    expect(authority.read()).toBe(1)
  })

  it("expires and refreshes without publishing when it has no realtime transport", async () => {
    const events: string[] = []
    nextCache.updateTag.mockImplementation(() => events.push("update"))
    nextCache.refresh.mockImplementation(() => events.push("refresh"))
    const binder = createMutationBinder({
      actor: () => "actor",
      authority: createAuthority(),
    })
    const execute = createNextMutationAction({
      protocol,
      binder,
      commands: [binder.bind(increment, command())],
    })

    await expect(execute(envelope)).resolves.toMatchObject(
      ok({ kind: "accepted" })
    )

    expect(events).toEqual(["update", "refresh"])
  })

  it("reports a rejected publication to the publisher's onFailure and stays accepted", async () => {
    const failure = new Error("publish failed")
    const onFailure = vi.fn()
    const execute = action(createAuthority(), command(), {
      invalidations: {
        publish: () => Promise.reject(failure),
        onFailure,
      },
    })

    await expect(execute(envelope)).resolves.toMatchObject(
      ok({ kind: "accepted" })
    )

    expect(onFailure).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ kind: "rejected", error: failure })
    )
  })

  // docs/server-setup.md, "Bind your commands": the binder fixes a command's
  // context, so a command needs no type annotation, inline or declared on its
  // own.
  it("infers a bound command's context, args, evidence, and screened value", async () => {
    const binder = createMutationBinder({
      actor: () => "actor",
      authority: createAuthority(),
    })
    const separate = binder.bind(increment, {
      screen: ({ actor, executor, args }) => {
        expectTypeOf(actor).toEqualTypeOf<string>()
        expectTypeOf(executor).toEqualTypeOf<CounterPreflight>()
        expectTypeOf(args).toEqualTypeOf<IncrementArgs>()
        return allowScreening({ count: executor.read() })
      },
      admit: ({ tx, actor }) => {
        expectTypeOf(tx).toEqualTypeOf<CounterTx>()
        expectTypeOf(actor).toEqualTypeOf<string>()
        return allowAdmission({ observed: tx.read() })
      },
      execute: ({ evidence }) => {
        expectTypeOf(evidence).toEqualTypeOf<{ observed: number }>()
        return acceptMutation()
      },
      finalizeAccepted: ({ screened }) => {
        expectTypeOf(screened).toEqualTypeOf<{ count: number }>()
      },
    })
    expect(() =>
      createNextMutationAction({ protocol, binder, commands: [separate] })
    ).not.toThrow()

    const finalized = vi.fn()
    const execute = createNextMutationAction({
      protocol,
      binder,
      commands: [
        binder.bind(increment, {
          screen: ({ actor, executor, args }) => {
            expectTypeOf(actor).toEqualTypeOf<string>()
            expectTypeOf(executor).toEqualTypeOf<CounterPreflight>()
            expectTypeOf(args).toEqualTypeOf<IncrementArgs>()
            return allowScreening({ count: executor.read() })
          },
          admit: ({ tx, actor }) => {
            expectTypeOf(tx).toEqualTypeOf<CounterTx>()
            expectTypeOf(actor).toEqualTypeOf<string>()
            return allowAdmission({ observed: tx.read() })
          },
          execute: ({ tx, args, evidence, stamp }) => {
            expectTypeOf(evidence).toEqualTypeOf<{ observed: number }>()
            // The refusal keeps its literal type without `as const`.
            if (args.amount < 0) return refuseMutation({ code: "refused" })
            tx.write(evidence.observed + args.amount)
            stamp.record(axisId("counter/value"), tx.read())
            return acceptMutation()
          },
          finalizeAccepted: ({ screened }) => {
            expectTypeOf(screened).toEqualTypeOf<{ count: number }>()
            finalized(screened)
          },
        }),
      ],
    })

    await expect(execute(envelope)).resolves.toMatchObject(
      ok({ kind: "accepted" })
    )
    expect(finalized).toHaveBeenCalledExactlyOnceWith({ count: 0 })
  })

  it("declares the actor once, from the callback, for any authority that accepts it", () => {
    const user = (): User => ({ id: "user" })
    const tenant = (): Tenant => ({ id: "user", tenantId: "tenant" })
    const byUser = (actor: User) => actor.id

    const exact = createMutationBinder({
      actor: user,
      authority: counterAuthorityFor(byUser),
    })
    const broader = createMutationBinder({
      actor: tenant,
      authority: counterAuthorityFor(byUser),
    })
    const anyActor = createMutationBinder({
      actor: user,
      authority: counterAuthorityFor((_actor: unknown) => "everyone"),
    })
    const asyncActor = createMutationBinder({
      actor: async () => user(),
      authority: counterAuthorityFor(byUser),
    })

    expectTypeOf(exact).toEqualTypeOf<
      MutationBinder<CounterTx, User, CounterPreflight>
    >()
    expectTypeOf(broader).toEqualTypeOf<
      MutationBinder<CounterTx, Tenant, CounterPreflight>
    >()
    expectTypeOf(anyActor).toEqualTypeOf<
      MutationBinder<CounterTx, User, CounterPreflight>
    >()
    expectTypeOf(asyncActor).toEqualTypeOf<
      MutationBinder<CounterTx, User, CounterPreflight>
    >()
    broader.bind(increment, {
      screen: ({ actor }) => {
        expectTypeOf(actor).toEqualTypeOf<Tenant>()
        return allowScreening()
      },
      admit: () => allowAdmission(),
      execute: () => acceptMutation(),
    })
    anyActor.bind(increment, {
      screen: ({ actor }) => {
        expectTypeOf(actor).toEqualTypeOf<User>()
        return allowScreening()
      },
      admit: () => allowAdmission(),
      execute: () => acceptMutation(),
    })
  })

  it("gives screening and finalization separate copies of the arguments", async () => {
    const finalizeAccepted = vi.fn()
    const registered = {
      ...command({ finalizeAccepted }),
      screen: ({ args }) => {
        ;(args as { amount: number }).amount = 99
        return allowScreening({ count: 0 })
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
      screen: ({ executor }) => allowScreening({ count: executor.read() }),
      admit: ({ tx }) => allowAdmission({ observed: tx.read() }),
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

    const binder = createMutationBinder({ actor: () => "actor", authority })

    expect(() =>
      createNextMutationAction({
        protocol,
        binder,
        // @ts-expect-error — the compiler rejects the duplicate too; this checks the runtime guard.
        commands: [
          binder.bind(increment, registered),
          binder.bind(increment, registered),
        ],
        invalidations: { publish: vi.fn(), onFailure: vi.fn() },
      })
    ).toThrow("Duplicate mutation binding: next.increment")
  })

  it("accepts an inline list and an `as const` list declared elsewhere", () => {
    const context = { protocol: pairProtocol, binder: counterBinder }

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

  // Same-typed binders cannot be told apart by types, so this is checked only
  // at runtime.
  it("rejects a binding made by another binder at construction", () => {
    const authority = createAuthority()
    const binder = createMutationBinder({ actor: () => "actor", authority })
    const other = createMutationBinder({ actor: () => "actor", authority })

    expect(() =>
      createNextMutationAction({
        protocol,
        binder,
        commands: [other.bind(increment, command())],
      })
    ).toThrow("Mutation binding was made by another binder: next.increment")
  })

  it("rejects missing command registration at construction", () => {
    expect(() =>
      createNextMutationAction({
        protocol,
        binder: counterBinder,
        commands: [] as never,
        invalidations: { publish: vi.fn(), onFailure: vi.fn() },
      })
    ).toThrow("Incomplete mutation bindings: missing [next.increment]")
  })
})

describe("Next mutation action for a mutation with no refusal cases", () => {
  const touch = defineMutation({
    name: "next.touch",
    args: incrementSchema,
    predict: (state: number) => ok(state),
  })
  const touchProtocol = defineProtocol({
    id: "test.next-server.touch.v1",
    mutations: [touch],
  })
  const touchEnvelope = {
    protocol: touchProtocol.id,
    mutationId: "5b3f2a61-4c7e-4d8a-9f0b-2e6c1d7a8b90",
    createdAt: Date.now(),
    invocation: touch({ amount: 1 }),
  }

  function touchAction(
    authority: CounterAuthority,
    execute: MutationCommand<
      typeof touch,
      string,
      CounterPreflight,
      CounterTx,
      undefined,
      undefined
    >["execute"]
  ) {
    const binder = createMutationBinder({ actor: () => "actor", authority })
    return createNextMutationAction({
      protocol: touchProtocol,
      binder,
      commands: [
        binder.bind(touch, {
          screen: () => allowScreening(),
          admit: () => allowAdmission(),
          execute,
        }),
      ],
    })
  }

  function createAuthority() {
    return createInMemoryMutationAuthority<number, string, unknown>({
      initialState: 0,
      scope: (actor) => actor,
    })
  }

  it("fails closed when a stored refusal reaches it", async () => {
    const authority: CounterAuthority = {
      preflight: { read: () => 0 },
      async execute(request) {
        request.parseRefusal?.({ code: "refused" })
        throw new Error("a refusal was admitted for a mutation without one")
      },
    }

    await expect(
      touchAction(authority, () => acceptMutation({ unchanged: true }))(
        touchEnvelope
      )
    ).rejects.toThrow("Invalid stored mutation refusal")
  })

  it("throws for an acceptance with an empty stamp and records no receipt", async () => {
    const authority = createAuthority()
    const execute = touchAction(authority, ({ tx }) => {
      tx.write(tx.read() + 1)
      return acceptMutation()
    })

    await expect(execute(touchEnvelope)).rejects.toThrow(
      "Mutation next.touch accepted with an empty stamp"
    )
    expect(authority.read()).toBe(0)
    expect(authority.receiptCount()).toBe(0)
    expect(nextCache.updateTag).not.toHaveBeenCalled()
  })

  it("accepts an explicit no-change acceptance with an empty stamp", async () => {
    const authority = createAuthority()
    const execute = touchAction(authority, () =>
      acceptMutation({ unchanged: true })
    )

    const first = await execute(touchEnvelope)
    const duplicate = await execute(touchEnvelope)

    expect(first).toEqual(ok({ kind: "accepted", stamp: { revisions: {} } }))
    expect(duplicate).toEqual(first)
    expect(authority.receiptCount()).toBe(1)
    expect(nextCache.updateTag).not.toHaveBeenCalled()
  })
})
