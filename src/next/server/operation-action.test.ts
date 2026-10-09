import type { StandardSchemaV1 } from "@standard-schema/spec"
import { err } from "serializable-result"
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest"

import { createNextOperationAction } from "."
import {
  axisId,
  createOperationEnvelope,
  defineOperation,
  type OperationActionOutcome,
  type OperationTerminalOutcome,
} from "../.."
import type { MutationExecutorError } from "../../core/authority"
import {
  acceptMutation,
  acceptOperation,
  allowAdmission,
  allowScreening,
  createMutationBinder,
  denyMutation,
  refuseMutation,
} from "../../server"
import {
  createInMemoryMutationAuthority,
  type InMemoryMutationAuthority,
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

type RunArgs = { readonly name: string }
type RunResult = { readonly runId: string }
type RunRefusal = "name-taken"

function testSchema<Output>(
  accepts: (value: unknown) => boolean
): StandardSchemaV1<unknown, Output> {
  return {
    "~standard": {
      version: 1,
      vendor: "headcanon-operation-action-test",
      validate: (value) =>
        accepts(value)
          ? { value: value as Output }
          : { issues: [{ message: "Rejected by the test schema" }] },
    },
  }
}

const runArgs = testSchema<RunArgs>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as { name?: unknown }).name === "string"
)
const runResult = testSchema<RunResult>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    Object.keys(value).length === 1 &&
    typeof (value as { runId?: unknown }).runId === "string"
)
const runRefusal = testSchema<RunRefusal>((value) => value === "name-taken")

const createRun = defineOperation({
  name: "test.run.create.v1",
  args: runArgs,
  result: runResult,
  refusal: runRefusal,
})

const runsAxis = axisId("test/runs")

interface Runs {
  readonly names: readonly string[]
  readonly revision: number
}

type Actor = { readonly id: string }

const EMPTY_RUNS: Runs = { names: [], revision: 0 }

/** A runs store, an authority over it, and the operation's action. */
function createHarness(
  options: {
    readonly result?: (runId: string) => unknown
    readonly screen?: (actor: Actor) => boolean
  } = {}
) {
  let actor: Actor = { id: "player-1" }
  const authority: InMemoryMutationAuthority<Runs, Actor, unknown> =
    createInMemoryMutationAuthority<Runs, Actor, unknown>({
      initialState: EMPTY_RUNS,
      scope: (current) => current.id,
    })
  const binder = createMutationBinder({ actor: () => actor, authority })
  const executed = vi.fn()
  const finalized = vi.fn()

  const binding = binder.bindOperation(createRun, {
    screen: ({ actor: current }) =>
      options.screen?.(current) === false
        ? denyMutation()
        : allowScreening(current.id),
    admit: ({ tx }) => allowAdmission(tx.read()),
    execute: ({ tx, args, evidence, stamp }) => {
      executed(args)
      if (evidence.names.includes(args.name))
        return refuseMutation("name-taken")

      const runId = crypto.randomUUID()
      const revision = evidence.revision + 1
      tx.write({ names: [...evidence.names, args.name], revision })
      stamp.record(runsAxis, revision)

      return acceptOperation(
        (options.result?.(runId) ?? { runId }) as RunResult
      )
    },
    finalizeAccepted: (context) => {
      finalized(context)
    },
  })

  return {
    authority,
    action: createNextOperationAction({ binder, binding }),
    executed,
    finalized,
    actAs(next: Actor) {
      actor = next
    },
  }
}

function acceptedResult(outcome: OperationActionOutcome<typeof createRun>) {
  if (!outcome.ok || outcome.value.kind !== "accepted") {
    throw new Error("Expected an accepted operation")
  }
  return outcome.value.result
}

describe("createNextOperationAction", () => {
  it("accepts with the command's result, finalizes it, and expires the stamp", async () => {
    const { action, authority, finalized } = createHarness()

    const outcome = await action(
      createOperationEnvelope(createRun, { name: "Emerald" })
    )

    const result = acceptedResult(outcome)
    expect(result).toEqual({ runId: expect.any(String) })
    expect(outcome).toEqual({
      ok: true,
      value: {
        kind: "accepted",
        stamp: { revisions: { [runsAxis]: 1 } },
        result,
      },
    })
    expect(authority.read().names).toEqual(["Emerald"])
    expect(finalized).toHaveBeenCalledWith({
      actor: { id: "player-1" },
      args: { name: "Emerald" },
      stamp: { revisions: { [runsAxis]: 1 } },
      result,
      screened: "player-1",
    })
    expect(nextCache.updateTag).toHaveBeenCalledTimes(1)
    expect(nextCache.refresh).toHaveBeenCalledTimes(1)
  })

  it("returns the recorded result to a redelivery without running the command again", async () => {
    const { action, authority, executed, finalized } = createHarness()
    const envelope = createOperationEnvelope(createRun, { name: "Emerald" })

    const first = await action(envelope)
    const redelivery = await action(structuredClone(envelope))

    expect(redelivery).toEqual(first)
    expect(executed).toHaveBeenCalledTimes(1)
    expect(authority.read().names).toEqual(["Emerald"])
    expect(finalized).toHaveBeenCalledTimes(2)
    expect(nextCache.updateTag).toHaveBeenCalledTimes(2)
  })

  it("refuses a reused mutation ID with other arguments and writes nothing", async () => {
    const { action, authority, executed } = createHarness()
    const envelope = createOperationEnvelope(createRun, { name: "Emerald" })

    await action(envelope)
    const reused = await action({
      ...envelope,
      invocation: { ...envelope.invocation, args: { name: "Ruby" } },
    })

    expect(reused).toEqual(
      err({ code: "mutation-id-reused", mutationId: envelope.mutationId })
    )
    expect(executed).toHaveBeenCalledTimes(1)
    expect(authority.read().names).toEqual(["Emerald"])
  })

  it("records a refusal and replays it", async () => {
    const { action, executed } = createHarness()
    await action(createOperationEnvelope(createRun, { name: "Emerald" }))
    const taken = createOperationEnvelope(createRun, { name: "Emerald" })

    const first = await action(taken)
    const replay = await action(taken)

    expect(first).toEqual({
      ok: true,
      value: { kind: "refused", error: "name-taken" },
    })
    expect(replay).toEqual(first)
    expect(executed).toHaveBeenCalledTimes(2)
  })

  it("gives each actor its own receipt for one mutation ID", async () => {
    const { action, executed, actAs } = createHarness()
    const envelope = createOperationEnvelope(createRun, { name: "Emerald" })

    acceptedResult(await action(envelope))
    actAs({ id: "player-2" })
    const second = await action(envelope)

    // Player 2 runs the command itself, so it sees the name player 1 took
    // instead of replaying player 1's accepted receipt.
    expect(second).toEqual({
      ok: true,
      value: { kind: "refused", error: "name-taken" },
    })
    expect(executed).toHaveBeenCalledTimes(2)
  })

  it("returns a screening denial without claiming a receipt", async () => {
    const { action, authority, executed } = createHarness({
      screen: () => false,
    })
    const envelope = createOperationEnvelope(createRun, { name: "Emerald" })

    expect(await action(envelope)).toEqual({
      ok: true,
      value: { kind: "denied" },
    })
    expect(executed).not.toHaveBeenCalled()
    expect(authority.receiptCount()).toBe(0)
  })

  it("rolls back an acceptance whose result the schema rejects", async () => {
    const { action, authority } = createHarness({
      result: (runId) => ({ runId, extra: true }),
    })
    const envelope = createOperationEnvelope(createRun, { name: "Emerald" })

    await expect(action(envelope)).rejects.toThrow(
      "Invalid stored operation result"
    )
    expect(authority.read()).toEqual(EMPTY_RUNS)
    expect(authority.receiptCount()).toBe(0)
    expect(nextCache.updateTag).not.toHaveBeenCalled()
  })

  it("refuses an envelope for another operation or a protocol", async () => {
    const { action } = createHarness()
    const other = defineOperation({
      name: "test.run.archive.v1",
      args: runArgs,
    })

    expect(
      await action(createOperationEnvelope(other, { name: "Emerald" }))
    ).toEqual(err({ code: "invalid-envelope", reason: "unknown-mutation" }))
    expect(
      await action({
        ...createOperationEnvelope(createRun, { name: "Emerald" }),
        protocol: "test.runs.v1",
      })
    ).toEqual(err({ code: "invalid-envelope", reason: "invalid-protocol" }))
  })

  it("rejects a binding made by another binder when it is created", () => {
    const authority = createInMemoryMutationAuthority<Runs, Actor, unknown>({
      initialState: EMPTY_RUNS,
      scope: (actor) => actor.id,
    })
    const binder = createMutationBinder({
      actor: () => ({ id: "player-1" }),
      authority,
    })
    const otherBinder = createMutationBinder({
      actor: () => ({ id: "player-1" }),
      authority,
    })
    const binding = otherBinder.bindOperation(createRun, {
      screen: () => allowScreening(),
      admit: () => allowAdmission(),
      execute: () => acceptOperation({ runId: "run" }, { unchanged: true }),
    })

    expect(() => createNextOperationAction({ binder, binding })).toThrow(
      "Operation binding was made by another binder: test.run.create.v1"
    )
  })

  it("types the action's outcome by the operation", () => {
    const { action } = createHarness()

    expectTypeOf(action).returns.resolves.toExtend<
      import("serializable-result").Result<
        OperationTerminalOutcome<RunResult, RunRefusal>,
        MutationExecutorError
      >
    >()
  })
})

// Each command below breaks the operation's contract, so each must fail to compile.
function rejectInvalidOperationCommandsAtCompileTime() {
  const binder = createMutationBinder({
    actor: () => ({ id: "player-1" }),
    authority: createInMemoryMutationAuthority<Runs, Actor, unknown>({
      initialState: EMPTY_RUNS,
      scope: (actor) => actor.id,
    }),
  })
  const checks = {
    screen: () => allowScreening(),
    admit: () => allowAdmission(),
  }

  binder.bindOperation(createRun, {
    ...checks,
    // @ts-expect-error — an operation acceptance must carry its result.
    execute: () => acceptMutation(),
  })
  binder.bindOperation(createRun, {
    ...checks,
    // @ts-expect-error — the result must match the result schema.
    execute: () => acceptOperation({ id: "run" }),
  })
  binder.bindOperation(createRun, {
    ...checks,
    // @ts-expect-error — the operation declares no such refusal.
    execute: () => refuseMutation("unknown-refusal"),
  })
  binder.bindOperation(createRun, {
    ...checks,
    // @ts-expect-error — the result is required.
    execute: () => acceptOperation(),
  })
}
void rejectInvalidOperationCommandsAtCompileTime
