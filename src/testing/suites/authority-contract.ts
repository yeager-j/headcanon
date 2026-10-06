import type { StandardSchemaV1 } from "@standard-schema/spec"
import { err, ok, type Result } from "serializable-result"
import { describe, expect, it } from "vitest"

import { hasExactKeys, isPlainRecord } from "../../core/admission"
import {
  DEFAULT_MUTATION_MAX_ATTEMPTS,
  executePreparedMutation,
  prepareMutationRequest,
  throwMutationContention,
  type MutationAuthorityAdapter,
  type MutationExecutorError,
  type MutationTerminalOutcome,
} from "../../core/authority"
import { defineMutation, defineProtocol } from "../../core/protocol"
import { axisId, revisionAt, type AcceptedStamp } from "../../core/revisions"
import {
  createInMemoryMutationAuthority,
  type InMemoryReader,
  type InMemoryTransaction,
} from "../in-memory-authority"
import type { ContractCase } from "./contract-case"

/** Axes the authority contract's fixture command writes, by name. */
export const MUTATION_AUTHORITY_CONTRACT_AXES = Object.freeze({
  primary: axisId("headcanon/contract/primary"),
  secondary: axisId("headcanon/contract/secondary"),
  rollback: axisId("headcanon/contract/rollback"),
})

/** One axis of the contract fixture's state. */
export type MutationAuthorityContractAxis =
  keyof typeof MUTATION_AUTHORITY_CONTRACT_AXES

/** The stored value and revision of one contract axis. */
export interface MutationAuthorityContractAxisState {
  readonly value: number
  readonly revision: number
}

/** The fixture state a harness stores for the authority contract. */
export interface MutationAuthorityContractState {
  readonly axes: Readonly<
    Record<MutationAuthorityContractAxis, MutationAuthorityContractAxisState>
  >
  /** Effects appended by committed attempts, in commit order. */
  readonly effects: readonly string[]
}

/** The state each fixture's storage must hold when `create` returns it. */
export const MUTATION_AUTHORITY_CONTRACT_INITIAL_STATE: MutationAuthorityContractState =
  Object.freeze({
    axes: Object.freeze({
      primary: Object.freeze({ value: 0, revision: 0 }),
      secondary: Object.freeze({ value: 0, revision: 0 }),
      rollback: Object.freeze({ value: 0, revision: 0 }),
    }),
    effects: Object.freeze([]),
  })

/** Structured refusal returned by the authority contract's fixture command. */
export type MutationAuthorityContractRefusal = {
  readonly code: "precondition" | "refused-after-write"
}

/**
 * The adapter under test and the storage its transactions reach. The
 * contract owns the fixture command; a harness only stores its state.
 */
export interface MutationAuthorityContractFixture<Transaction, Preflight> {
  /**
   * The adapter under test, with its default attempt ceiling. The contract
   * executes every mutation as one string actor.
   */
  readonly authority: MutationAuthorityAdapter<
    Transaction,
    string,
    MutationAuthorityContractRefusal,
    Preflight
  >
  /** Reads the fixture state through an attempt's transaction or the preflight executor. */
  load(
    executor: Transaction | Preflight
  ): Promise<MutationAuthorityContractState>
  /**
   * Compare-and-set write of one axis inside an attempt.
   * @returns `false`, writing nothing, when the axis's committed revision is no longer `expectedRevision`.
   */
  writeAxis(
    tx: Transaction,
    axis: MutationAuthorityContractAxis,
    expectedRevision: number,
    next: MutationAuthorityContractAxisState
  ): Promise<boolean>
  /** Appends one effect inside an attempt. */
  appendEffect(tx: Transaction, effect: string): Promise<void>
  /** Commits `next` outside any attempt, as another writer would. */
  replace(next: MutationAuthorityContractState): Promise<void>
  /** Counts every receipt in the adapter's storage. */
  receiptCount(): Promise<number>
  /**
   * Whether storage holds a receipt for `mutationId`. The contract executes
   * every mutation as one actor.
   */
  hasReceipt(mutationId: string): Promise<boolean>
}

/**
 * Names a mutation authority under test and creates a fresh fixture for each
 * contract case.
 */
export interface MutationAuthorityContractHarness<Transaction, Preflight> {
  /** Label that prefixes the contract's `describe` block. */
  readonly name: string
  /**
   * Creates an isolated fixture whose storage holds
   * `MUTATION_AUTHORITY_CONTRACT_INITIAL_STATE`. Called once per case.
   */
  create():
    | MutationAuthorityContractFixture<Transaction, Preflight>
    | Promise<MutationAuthorityContractFixture<Transaction, Preflight>>
}

const CONTRACT_PROTOCOL = "headcanon.authority-contract.v1"
const CONTRACT_MUTATION = "authority-contract.apply"
const CONTRACT_ACTOR = "contract-actor"
const CONTRACT_AXES = Object.keys(
  MUTATION_AUTHORITY_CONTRACT_AXES
) as readonly MutationAuthorityContractAxis[]
const CONTRACT_BEHAVIORS = [
  "accept",
  "refuse",
  "throw",
  "mutate-args-when-zero",
] as const

interface ContractArgs {
  readonly amount: number
  readonly axes: readonly MutationAuthorityContractAxis[]
  readonly behavior: (typeof CONTRACT_BEHAVIORS)[number]
  readonly effect: string
  readonly maximumPrimary: number | null
}

function isContractArgs(value: unknown): value is ContractArgs {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, [
      "amount",
      "axes",
      "behavior",
      "effect",
      "maximumPrimary",
    ]) &&
    Number.isSafeInteger(value.amount) &&
    Array.isArray(value.axes) &&
    value.axes.every((axis) => CONTRACT_AXES.includes(axis)) &&
    CONTRACT_BEHAVIORS.some((behavior) => behavior === value.behavior) &&
    typeof value.effect === "string" &&
    (value.maximumPrimary === null ||
      Number.isSafeInteger(value.maximumPrimary))
  )
}

const contractArgsSchema: StandardSchemaV1<unknown, ContractArgs> = {
  "~standard": {
    version: 1,
    vendor: "headcanon",
    validate(value: unknown) {
      return isContractArgs(value)
        ? { value }
        : { issues: [{ message: "Invalid authority contract arguments" }] }
    },
  },
}

const contractMutation = defineMutation({
  name: CONTRACT_MUTATION,
  args: contractArgsSchema,
  predict(state: MutationAuthorityContractState) {
    return ok(state)
  },
})

const contractProtocol = defineProtocol({
  id: CONTRACT_PROTOCOL,
  mutations: [contractMutation],
})

function parseContractRefusal(
  value: unknown
): MutationAuthorityContractRefusal {
  if (
    isPlainRecord(value) &&
    hasExactKeys(value, ["code"]) &&
    (value.code === "precondition" || value.code === "refused-after-write")
  ) {
    return { code: value.code }
  }
  throw new Error("Invalid authority contract refusal")
}

function contractEnvelope(sequence: number, args: ContractArgs) {
  return {
    protocol: CONTRACT_PROTOCOL,
    mutationId: `00000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`,
    invocation: { name: CONTRACT_MUTATION, args },
  }
}

function contractArgs(overrides: Partial<ContractArgs> = {}): ContractArgs {
  return {
    amount: 1,
    axes: ["primary"],
    behavior: "accept",
    effect: "effect",
    maximumPrimary: null,
    ...overrides,
  }
}

type ContractOutcome = Result<
  MutationTerminalOutcome<MutationAuthorityContractRefusal>,
  MutationExecutorError
>

interface ContractDriver {
  execute(
    envelope: unknown,
    options?: {
      /** Whether the request carries the contract's refusal parser. */
      readonly parseRefusal?: boolean
      /** Runs inside each attempt after its writes. */
      readonly afterWrites?: () => Promise<void>
    }
  ): Promise<ContractOutcome>
  read(): Promise<MutationAuthorityContractState>
  replace(next: MutationAuthorityContractState): Promise<void>
  /** Makes the next attempt lose a race to a committed `primary` write. */
  contendNext(primaryDelta: number): void
  receiptCount(): Promise<number>
  hasReceipt(mutationId: string): Promise<boolean>
  attemptCount(mutationId: string): number
}

async function createDriver<Transaction, Preflight>(
  harness: MutationAuthorityContractHarness<Transaction, Preflight>
): Promise<ContractDriver> {
  const fixture = await harness.create()
  const attempts = new Map<string, number>()
  const contention = new Array<number>()
  const read = () => fixture.load(fixture.authority.preflight)

  const commitConcurrently = async (primaryDelta: number) => {
    const current = await read()
    const primary = current.axes.primary
    await fixture.replace({
      ...current,
      axes: {
        ...current.axes,
        primary: {
          value: primary.value + primaryDelta,
          revision: primary.revision + 1,
        },
      },
    })
  }

  return {
    async execute(envelope, options = {}) {
      const prepared = await prepareMutationRequest(contractProtocol, envelope)
      if (!prepared.ok) return prepared
      const { mutationId } = prepared.value

      return executePreparedMutation({
        prepared: prepared.value,
        actor: CONTRACT_ACTOR,
        authority: fixture.authority,
        parseRefusal:
          options.parseRefusal === false ? undefined : parseContractRefusal,
        async run(tx, stamp, parsedArgs) {
          attempts.set(mutationId, (attempts.get(mutationId) ?? 0) + 1)
          const args = parsedArgs as ContractArgs
          const current = await fixture.load(tx)
          const primary = current.axes.primary.value
          if (args.maximumPrimary !== null && primary > args.maximumPrimary) {
            return err({ kind: "refused", error: { code: "precondition" } })
          }

          await fixture.appendEffect(tx, args.effect)
          if (args.behavior === "mutate-args-when-zero" && primary === 0) {
            const mutableArgs = args as { amount: number }
            mutableArgs.amount = 100
          }

          const primaryDelta = contention.shift()
          if (primaryDelta !== undefined) await commitConcurrently(primaryDelta)

          for (const axis of args.axes) {
            // Write rollback only while primary is zero, so an attempt that
            // lost a race to a primary write stamps an axis its rerun does not.
            if (axis === "rollback" && primary !== 0) continue
            const { value, revision } = current.axes[axis]
            const next = { value: value + args.amount, revision: revision + 1 }
            if (!(await fixture.writeAxis(tx, axis, revision, next))) {
              throwMutationContention()
            }
            stamp.record(MUTATION_AUTHORITY_CONTRACT_AXES[axis], next.revision)
          }
          await options.afterWrites?.()

          if (args.behavior === "throw") {
            throw new Error("authority contract exception")
          }
          if (args.behavior === "refuse") {
            return err({
              kind: "refused",
              error: { code: "refused-after-write" },
            })
          }
          return ok(undefined)
        },
      })
    },
    read,
    replace: (next) => fixture.replace(next),
    contendNext(primaryDelta) {
      contention.push(primaryDelta)
    },
    receiptCount: () => fixture.receiptCount(),
    hasReceipt: (mutationId) => fixture.hasReceipt(mutationId),
    attemptCount: (mutationId) => attempts.get(mutationId) ?? 0,
  }
}

function requireTerminal(
  result: ContractOutcome
): MutationTerminalOutcome<MutationAuthorityContractRefusal> {
  if (!result.ok) {
    throw new Error(`Expected terminal outcome, received ${result.error.code}`)
  }
  return result.value
}

function requireAccepted(result: ContractOutcome): AcceptedStamp {
  const terminal = requireTerminal(result)
  if (terminal.kind !== "accepted") {
    throw new Error("Expected accepted authority outcome")
  }
  return terminal.stamp
}

/**
 * The authority contract's cases for one harness. Internal to the package:
 * tests use it to run the cases against deliberately broken harnesses.
 * @param harness The adapter's harness; `create` runs once per case.
 * @returns The contract cases, in order.
 */
export function mutationAuthorityContractCases<Transaction, Preflight>(
  harness: MutationAuthorityContractHarness<Transaction, Preflight>
): readonly ContractCase[] {
  const { primary, secondary } = MUTATION_AUTHORITY_CONTRACT_AXES
  const initial = MUTATION_AUTHORITY_CONTRACT_INITIAL_STATE

  return [
    {
      name: "runs replayable and preconditioned commands against current authority",
      async run() {
        const contract = await createDriver(harness)
        await contract.replace({
          ...initial,
          axes: { ...initial.axes, primary: { value: 5, revision: 4 } },
        })

        const replayable = contractEnvelope(
          2,
          contractArgs({ amount: 2, effect: "current-authority" })
        )
        requireAccepted(await contract.execute(replayable))
        expect(await contract.read()).toMatchObject({
          axes: { primary: { value: 7, revision: 5 } },
          effects: ["current-authority"],
        })

        const preconditioned = contractEnvelope(
          3,
          contractArgs({ maximumPrimary: 6, effect: "must-not-run" })
        )
        expect(requireTerminal(await contract.execute(preconditioned))).toEqual(
          { kind: "refused", error: { code: "precondition" } }
        )
        expect((await contract.read()).effects).toEqual(["current-authority"])
      },
    },
    {
      name: "reruns load and handler after one CAS loss without retaining attempt effects",
      async run() {
        const contract = await createDriver(harness)
        const envelope = contractEnvelope(
          4,
          contractArgs({ amount: 2, effect: "once-after-retry" })
        )
        contract.contendNext(10)

        const stamp = requireAccepted(await contract.execute(envelope))

        expect(await contract.read()).toMatchObject({
          axes: { primary: { value: 12, revision: 2 } },
          effects: ["once-after-retry"],
        })
        expect(revisionAt(stamp.revisions, primary)).toBe(2)
        expect(contract.attemptCount(envelope.mutationId)).toBe(2)
      },
    },
    {
      name: "gives every contention attempt fresh canonical arguments",
      async run() {
        const contract = await createDriver(harness)
        const envelope = contractEnvelope(
          14,
          contractArgs({
            behavior: "mutate-args-when-zero",
            effect: "fresh-arguments",
          })
        )
        contract.contendNext(10)

        requireAccepted(await contract.execute(envelope))

        expect(await contract.read()).toMatchObject({
          axes: { primary: { value: 11 } },
          effects: ["fresh-arguments"],
        })
        expect(contract.attemptCount(envelope.mutationId)).toBe(2)
      },
    },
    {
      name: "discards a rolled-back attempt's stamp entries",
      async run() {
        const contract = await createDriver(harness)
        const envelope = contractEnvelope(
          5,
          contractArgs({
            axes: ["rollback", "primary"],
            effect: "rollback-stamp",
          })
        )
        contract.contendNext(10)

        const stamp = requireAccepted(await contract.execute(envelope))

        expect(stamp.revisions).toEqual({ [primary]: 2 })
        expect(await contract.read()).toMatchObject({
          axes: {
            primary: { value: 11 },
            rollback: { value: 0, revision: 0 },
          },
          effects: ["rollback-stamp"],
        })
      },
    },
    {
      name: "records every committed axis atomically in the accepted vector",
      async run() {
        const contract = await createDriver(harness)
        const envelope = contractEnvelope(
          6,
          contractArgs({ axes: ["primary", "secondary"], effect: "multi-axis" })
        )

        const stamp = requireAccepted(await contract.execute(envelope))

        expect(stamp.revisions).toEqual({ [primary]: 1, [secondary]: 1 })
        expect(await contract.read()).toMatchObject({
          axes: {
            primary: { value: 1, revision: 1 },
            secondary: { value: 1, revision: 1 },
          },
          effects: ["multi-axis"],
        })
      },
    },
    {
      name: "rolls back partial handler work before recording a terminal refusal",
      async run() {
        const contract = await createDriver(harness)
        const envelope = contractEnvelope(
          7,
          contractArgs({ behavior: "refuse", effect: "rolled-back" })
        )

        const first = requireTerminal(await contract.execute(envelope))
        const duplicate = requireTerminal(await contract.execute(envelope))

        expect(first).toEqual({
          kind: "refused",
          error: { code: "refused-after-write" },
        })
        expect(duplicate).toEqual(first)
        expect(await contract.read()).toEqual(initial)
        expect(contract.attemptCount(envelope.mutationId)).toBe(1)
        expect(await contract.hasReceipt(envelope.mutationId)).toBe(true)
      },
    },
    {
      name: "isolates a recorded refusal from caller mutation",
      async run() {
        const contract = await createDriver(harness)
        const envelope = contractEnvelope(
          13,
          contractArgs({ behavior: "refuse", effect: "immutable-receipt" })
        )

        const first = requireTerminal(await contract.execute(envelope))
        if (first.kind !== "refused") {
          throw new Error("Expected contract refusal")
        }
        const callerOwnedError = first.error as { code: string }
        callerOwnedError.code = "caller-corruption"

        expect(requireTerminal(await contract.execute(envelope))).toEqual({
          kind: "refused",
          error: { code: "refused-after-write" },
        })
      },
    },
    {
      name: "fails closed when a refusal crosses the receipt boundary without a parser",
      async run() {
        const contract = await createDriver(harness)
        const envelope = contractEnvelope(
          15,
          contractArgs({ behavior: "refuse", effect: "unparsed" })
        )

        await expect(
          contract.execute(envelope, { parseRefusal: false })
        ).rejects.toThrow()
        expect(await contract.hasReceipt(envelope.mutationId)).toBe(false)

        expect(requireTerminal(await contract.execute(envelope))).toEqual({
          kind: "refused",
          error: { code: "refused-after-write" },
        })
        await expect(
          contract.execute(envelope, { parseRefusal: false })
        ).rejects.toThrow()
      },
    },
    {
      name: "returns recorded duplicates without rerunning and rejects ID collisions",
      async run() {
        const contract = await createDriver(harness)
        const envelope = contractEnvelope(
          8,
          contractArgs({ effect: "deduplicated" })
        )
        const first = await contract.execute(envelope)
        const duplicate = await contract.execute(structuredClone(envelope))
        const collision = await contract.execute({
          ...envelope,
          invocation: {
            ...envelope.invocation,
            args: { ...envelope.invocation.args, amount: 2 },
          },
        })

        expect(duplicate).toEqual(first)
        expect(collision).toEqual(
          err({ code: "mutation-id-reused", mutationId: envelope.mutationId })
        )
        expect((await contract.read()).effects).toEqual(["deduplicated"])
        expect(contract.attemptCount(envelope.mutationId)).toBe(1)
      },
    },
    {
      name: "collapses concurrent delivery of one mutation ID to one effect",
      async run() {
        const contract = await createDriver(harness)
        const envelope = contractEnvelope(
          12,
          contractArgs({ effect: "concurrent-deduplication" })
        )

        const [first, second] = await Promise.all([
          contract.execute(envelope),
          contract.execute(structuredClone(envelope)),
        ])

        expect(second).toEqual(first)
        expect((await contract.read()).effects).toEqual([
          "concurrent-deduplication",
        ])
        expect(contract.attemptCount(envelope.mutationId)).toBe(1)
      },
    },
    {
      name: "treats differently ordered object keys as the same canonical invocation",
      async run() {
        const contract = await createDriver(harness)
        const envelope = contractEnvelope(
          9,
          contractArgs({ effect: "canonical-order" })
        )
        const { args } = envelope.invocation
        const reorderedArgs = {
          maximumPrimary: args.maximumPrimary,
          effect: args.effect,
          behavior: args.behavior,
          axes: args.axes,
          amount: args.amount,
        }

        const first = await contract.execute(envelope)
        const duplicate = await contract.execute({
          ...envelope,
          invocation: { name: CONTRACT_MUTATION, args: reorderedArgs },
        })

        expect(duplicate).toEqual(first)
        expect(contract.attemptCount(envelope.mutationId)).toBe(1)
      },
    },
    {
      name: "stores no receipt after exhausted contention and preserves the mutation ID",
      async run() {
        const contract = await createDriver(harness)
        const envelope = contractEnvelope(
          10,
          contractArgs({ effect: "retry-same-id" })
        )
        for (let lost = 0; lost < DEFAULT_MUTATION_MAX_ATTEMPTS; lost += 1) {
          contract.contendNext(1)
        }

        expect(await contract.execute(envelope)).toEqual(
          err({ code: "contention", mutationId: envelope.mutationId })
        )
        expect(await contract.hasReceipt(envelope.mutationId)).toBe(false)
        expect((await contract.read()).effects).toEqual([])

        requireAccepted(await contract.execute(envelope))
        expect(await contract.hasReceipt(envelope.mutationId)).toBe(true)
        expect((await contract.read()).effects).toEqual(["retry-same-id"])
      },
    },
    {
      name: "rolls back unexpected exceptions without recording a receipt",
      async run() {
        const contract = await createDriver(harness)
        const envelope = contractEnvelope(
          11,
          contractArgs({ behavior: "throw", effect: "exception" })
        )

        await expect(contract.execute(envelope)).rejects.toThrow(
          "authority contract exception"
        )
        expect(await contract.read()).toEqual(initial)
        expect(await contract.hasReceipt(envelope.mutationId)).toBe(false)
      },
    },
    {
      name: "screens through a preflight executor that sees only committed state",
      async run() {
        const contract = await createDriver(harness)
        const envelope = contractEnvelope(
          16,
          contractArgs({ effect: "preflight" })
        )
        let observedMidAttempt: MutationAuthorityContractState | undefined

        requireAccepted(
          await contract.execute(envelope, {
            async afterWrites() {
              observedMidAttempt = await contract.read()
            },
          })
        )

        expect(observedMidAttempt).toEqual(initial)
        expect(await contract.read()).toMatchObject({
          axes: { primary: { value: 1, revision: 1 } },
          effects: ["preflight"],
        })
        expect(await contract.receiptCount()).toBe(1)
      },
    },
  ]
}

/**
 * Runs the reusable black-box authority contract against one adapter. The
 * contract owns the fixture command and runs it through the same admission and
 * execution path as a generated action; the harness supplies the adapter and
 * the storage its transactions reach. Registers one vitest `describe` block,
 * so call it at a test file's top level. Runs in the `node` environment.
 * @param harness The adapter's harness; `create` runs once per case.
 * @returns Nothing; registers the contract's tests.
 */
export function verifyMutationAuthorityContract<Transaction, Preflight>(
  harness: MutationAuthorityContractHarness<Transaction, Preflight>
): void {
  describe(`${harness.name} mutation authority contract`, () => {
    for (const contractCase of mutationAuthorityContractCases(harness)) {
      it(contractCase.name, () => contractCase.run())
    }
  })
}

/**
 * A ready-to-run in-memory harness for `verifyMutationAuthorityContract`.
 * @returns A harness that creates an isolated in-memory authority per case.
 */
export function createInMemoryMutationAuthorityContractHarness(): MutationAuthorityContractHarness<
  InMemoryTransaction<MutationAuthorityContractState>,
  InMemoryReader<MutationAuthorityContractState>
> {
  return {
    name: "in-memory",
    create() {
      const authority = createInMemoryMutationAuthority<
        MutationAuthorityContractState,
        string,
        MutationAuthorityContractRefusal
      >({
        initialState: MUTATION_AUTHORITY_CONTRACT_INITIAL_STATE,
        scope: (actor) => actor,
      })

      return {
        authority,
        load: async (executor) => executor.read(),
        async writeAxis(tx, axis, expectedRevision, next) {
          if (authority.read().axes[axis].revision !== expectedRevision) {
            return false
          }
          const current = tx.read()
          tx.write({ ...current, axes: { ...current.axes, [axis]: next } })
          return true
        },
        async appendEffect(tx, effect) {
          const current = tx.read()
          tx.write({ ...current, effects: [...current.effects, effect] })
        },
        replace: async (next) => authority.replace(next),
        receiptCount: async () => authority.receiptCount(),
        hasReceipt: async (mutationId) =>
          authority.hasReceipt(CONTRACT_ACTOR, mutationId),
      }
    },
  }
}
