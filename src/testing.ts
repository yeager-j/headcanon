import type { StandardSchemaV1 } from "@standard-schema/spec"
import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { err, ok, type Result } from "@workspace/result"

import {
  createStampAccumulator,
  executePreparedMutation,
  prepareMutationRequest,
  type MutationAttemptFailure,
  type MutationAuthorityAdapter,
  type MutationAuthorityAdapterError,
  type MutationAuthorityRequest,
  type MutationEnvelope,
  type MutationExecutorError,
  type MutationTerminalOutcome,
  type StampAccumulator,
} from "./authority"
import {
  createNoRealtimeInvalidationAdapter,
  type AxisInvalidation,
  type InvalidationAdapter,
  type InvalidationPublisher,
  type InvalidationStatus,
  type InvalidationSubscription,
} from "./invalidation"
import { defineMutation, defineProtocol } from "./protocol"
import {
  useIncorporation,
  withPollingFallback,
  type IncorporationStatus,
  type RefreshAdapter,
} from "./refresh"
import {
  acceptedStamp,
  axisId,
  revisionVector,
  type AcceptedStamp,
  type AxisId,
  type Canon,
  type Revision,
  type RevisionVector,
} from "./revisions"

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  return left.every((byte, index) => byte === right[index])
}

function cloneValue<Value>(value: Value): Value {
  return structuredClone(value)
}

/** A small transactional state cell used only by the in-memory test adapter. */
export interface InMemoryTransaction<State> {
  read(): State
  write(next: State): void
}

export interface InMemoryMutationAuthority<
  State,
  Actor,
  Rejection,
> extends MutationAuthorityAdapter<
  InMemoryTransaction<State>,
  Actor,
  Rejection
> {
  read(): State
  replace(next: State): void
  contendNext(update?: (current: State) => State): void
  receiptCount(): number
  hasReceipt(actor: Actor, mutationId: string): boolean
  attemptCount(actor: Actor, mutationId: string): number
}

interface InMemoryReceipt<Rejection> {
  readonly canonicalBytes: Uint8Array
  readonly outcome: MutationTerminalOutcome<Rejection>
}

interface PendingExecution<Rejection> {
  readonly canonicalBytes: Uint8Array
  readonly outcome: Promise<
    Result<MutationTerminalOutcome<Rejection>, MutationAuthorityAdapterError>
  >
}

function receiptKey(scope: string, mutationId: string): string {
  return JSON.stringify([scope, mutationId])
}

/**
 * Creates an effectively-once in-memory authority for contract and fixture use.
 *
 * Each attempt receives an isolated state cell and stamp accumulator. Injected
 * contention discards both, optionally advances external authority, and reruns
 * the handler against the newer committed state.
 */
export function createInMemoryMutationAuthority<
  State,
  Actor,
  Rejection,
>(options: {
  readonly initialState: State
  readonly scope: (actor: Actor) => string
  readonly clone?: (value: State) => State
  readonly cloneRejection?: (value: Rejection) => Rejection
  readonly maxAttempts?: number
}): InMemoryMutationAuthority<State, Actor, Rejection> {
  const clone = options.clone ?? cloneValue
  const cloneRejection = options.cloneRejection ?? cloneValue
  const maxAttempts = options.maxAttempts ?? 2
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("maxAttempts must be a positive integer")
  }

  let state = clone(options.initialState)
  let lock = Promise.resolve()
  const receipts = new Map<string, InMemoryReceipt<Rejection>>()
  const pending = new Map<string, PendingExecution<Rejection>>()
  const attempts = new Map<string, number>()
  const contention = new Array<(current: State) => State>()

  const exclusively = async <Value>(run: () => Promise<Value>) => {
    const previous = lock
    let release: () => void = () => undefined
    lock = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await run()
    } finally {
      release()
    }
  }

  const collision = (mutationId: string) =>
    err({ code: "mutation-id-reused", mutationId } as const)

  const copyOutcome = (
    outcome: MutationTerminalOutcome<Rejection>,
    parseRejection?: (value: unknown) => Rejection
  ): MutationTerminalOutcome<Rejection> =>
    outcome.kind === "accepted"
      ? outcome
      : outcome.kind === "denied"
        ? outcome
        : Object.freeze({
            kind: "rejected",
            error: parseRejection
              ? parseRejection(JSON.parse(JSON.stringify(outcome.error)))
              : cloneRejection(outcome.error),
          })

  const execute = async (
    request: MutationAuthorityRequest<Actor, Rejection>,
    run: (
      tx: InMemoryTransaction<State>,
      stamp: StampAccumulator
    ) => Promise<Result<void, MutationAttemptFailure<Rejection>>>
  ): Promise<
    Result<MutationTerminalOutcome<Rejection>, MutationAuthorityAdapterError>
  > => {
    const key = receiptKey(options.scope(request.actor), request.mutationId)
    const recorded = receipts.get(key)
    if (recorded) {
      return equalBytes(recorded.canonicalBytes, request.canonical.bytes)
        ? ok(copyOutcome(recorded.outcome, request.parseRejection))
        : collision(request.mutationId)
    }

    const active = pending.get(key)
    if (active) {
      return equalBytes(active.canonicalBytes, request.canonical.bytes)
        ? active.outcome.then((result) =>
            result.ok
              ? ok(copyOutcome(result.value, request.parseRejection))
              : result
          )
        : collision(request.mutationId)
    }

    const outcome = exclusively(async () => {
      const committedWhileWaiting = receipts.get(key)
      if (committedWhileWaiting) {
        return equalBytes(
          committedWhileWaiting.canonicalBytes,
          request.canonical.bytes
        )
          ? ok(
              copyOutcome(committedWhileWaiting.outcome, request.parseRejection)
            )
          : collision(request.mutationId)
      }

      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        attempts.set(key, (attempts.get(key) ?? 0) + 1)
        let draft = clone(state)
        const tx: InMemoryTransaction<State> = {
          read: () => clone(draft),
          write: (next) => {
            draft = clone(next)
          },
        }
        const stamp = createStampAccumulator()
        const handled = await run(tx, stamp)

        if (!handled.ok) {
          const terminal =
            handled.error.kind === "denied"
              ? (Object.freeze({
                  kind: "denied",
                }) satisfies MutationTerminalOutcome<Rejection>)
              : (Object.freeze({
                  kind: "rejected",
                  error: cloneRejection(handled.error.error),
                }) satisfies MutationTerminalOutcome<Rejection>)
          receipts.set(key, {
            canonicalBytes: request.canonical.bytes.slice(),
            outcome: terminal,
          })
          return ok(copyOutcome(terminal, request.parseRejection))
        }

        const contentionUpdate = contention.shift()
        if (contentionUpdate) {
          state = clone(contentionUpdate(clone(state)))
          continue
        }

        const terminal = Object.freeze({
          kind: "accepted",
          stamp: stamp.accepted(),
        }) satisfies MutationTerminalOutcome<Rejection>
        state = draft
        receipts.set(key, {
          canonicalBytes: request.canonical.bytes.slice(),
          outcome: terminal,
        })
        return ok(terminal)
      }

      return err({
        code: "contention",
        mutationId: request.mutationId,
      } as const)
    })

    pending.set(key, {
      canonicalBytes: request.canonical.bytes.slice(),
      outcome,
    })
    try {
      return await outcome
    } finally {
      pending.delete(key)
    }
  }

  return {
    execute,
    read: () => clone(state),
    replace(next) {
      state = clone(next)
    },
    contendNext(update = (current) => current) {
      contention.push(update)
    },
    receiptCount: () => receipts.size,
    hasReceipt(actor, mutationId) {
      return receipts.has(receiptKey(options.scope(actor), mutationId))
    },
    attemptCount(actor, mutationId) {
      return attempts.get(receiptKey(options.scope(actor), mutationId)) ?? 0
    },
  }
}

export interface InMemoryInvalidationAdapter
  extends InvalidationAdapter, InvalidationPublisher {
  readonly published: readonly AxisInvalidation[]
  setStatus(status: InvalidationStatus): void
}

/** A synchronous per-axis invalidation bus for tests and local fixtures. */
export function createInMemoryInvalidationAdapter(): InMemoryInvalidationAdapter {
  const subscriptions = new Set<InvalidationSubscription>()
  const published: AxisInvalidation[] = []
  let status: InvalidationStatus = "active"

  return {
    get initialStatus() {
      return status
    },
    get published() {
      return Object.freeze([...published])
    },
    subscribe(subscription) {
      subscriptions.add(subscription)
      subscription.onStatusChange(status)
      return () => subscriptions.delete(subscription)
    },
    publish(eventId, stamp) {
      for (const [rawAxis, stampedRevision] of Object.entries(
        stamp.revisions
      )) {
        const invalidation = Object.freeze({
          eventId,
          axis: axisId(rawAxis),
          revision: stampedRevision,
        })
        published.push(invalidation)

        for (const subscription of subscriptions) {
          if (!subscription.axes.includes(invalidation.axis)) continue
          subscription.onInvalidation(invalidation)
        }
      }
    },
    setStatus(nextStatus) {
      status = nextStatus
      for (const subscription of subscriptions) {
        subscription.onStatusChange(nextStatus)
      }
    },
  }
}

export const MUTATION_AUTHORITY_CONTRACT_PROTOCOL =
  "headcanon.authority-contract.v1"
export const MUTATION_AUTHORITY_CONTRACT_MUTATION = "authority-contract.apply"
export const MUTATION_AUTHORITY_CONTRACT_ACTOR = "contract-actor"

export const MUTATION_AUTHORITY_CONTRACT_AXES = Object.freeze({
  primary: axisId("headcanon/contract/primary"),
  secondary: axisId("headcanon/contract/secondary"),
  rollback: axisId("headcanon/contract/rollback"),
})

const PRIMARY_AXIS = MUTATION_AUTHORITY_CONTRACT_AXES.primary
const SECONDARY_AXIS = MUTATION_AUTHORITY_CONTRACT_AXES.secondary
const ROLLBACK_AXIS = MUTATION_AUTHORITY_CONTRACT_AXES.rollback

export type MutationAuthorityContractAxis =
  | "primary"
  | "secondary"
  | "rollback-when-zero"
export type MutationAuthorityContractBehavior =
  | "accept"
  | "reject"
  | "throw"
  | "mutate-args-when-zero"

export interface MutationAuthorityContractArgs {
  readonly amount: number
  readonly axes: readonly MutationAuthorityContractAxis[]
  readonly behavior: MutationAuthorityContractBehavior
  readonly effect: string
  readonly maximumPrimary: number | null
}

type AuthorityContractArgs = MutationAuthorityContractArgs

export interface MutationAuthorityContractState {
  readonly primary: number
  readonly secondary: number
  readonly rollbackOnly: number
  readonly revisions: {
    readonly primary: number
    readonly secondary: number
    readonly rollbackOnly: number
  }
  readonly effects: readonly string[]
}

export type MutationAuthorityContractRejection = {
  readonly code: "precondition" | "rejected-after-write"
}

export interface MutationAuthorityContractDriver {
  execute(
    envelope: unknown
  ): Promise<
    Result<
      MutationTerminalOutcome<MutationAuthorityContractRejection>,
      MutationExecutorError
    >
  >
  read(): Promise<MutationAuthorityContractState>
  replace(next: MutationAuthorityContractState): Promise<void>
  contendNext(primaryDelta?: number): Promise<void>
  receiptCount(): Promise<number>
  hasReceipt(mutationId: string): Promise<boolean>
  attemptCount(mutationId: string): Promise<number>
}

export interface MutationAuthorityContractHarness {
  readonly name: string
  create():
    | MutationAuthorityContractDriver
    | Promise<MutationAuthorityContractDriver>
}

function isContractArgs(value: unknown): value is AuthorityContractArgs {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const input = value as Record<string, unknown>
  if (
    Object.keys(input).length !== 5 ||
    typeof input.amount !== "number" ||
    !Number.isSafeInteger(input.amount) ||
    !Array.isArray(input.axes) ||
    !input.axes.every(
      (axis) =>
        axis === "primary" ||
        axis === "secondary" ||
        axis === "rollback-when-zero"
    ) ||
    (input.behavior !== "accept" &&
      input.behavior !== "reject" &&
      input.behavior !== "throw" &&
      input.behavior !== "mutate-args-when-zero") ||
    typeof input.effect !== "string" ||
    (input.maximumPrimary !== null &&
      (typeof input.maximumPrimary !== "number" ||
        !Number.isSafeInteger(input.maximumPrimary)))
  ) {
    return false
  }

  return true
}

const authorityContractArgsSchema: StandardSchemaV1<
  unknown,
  AuthorityContractArgs
> = {
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

export const mutationAuthorityContractMutation = defineMutation({
  name: MUTATION_AUTHORITY_CONTRACT_MUTATION,
  args: authorityContractArgsSchema,
  predict(state: MutationAuthorityContractState) {
    return ok(state)
  },
})

export const mutationAuthorityContractProtocol = defineProtocol({
  id: MUTATION_AUTHORITY_CONTRACT_PROTOCOL,
  mutations: [mutationAuthorityContractMutation],
})

export const MUTATION_AUTHORITY_CONTRACT_INITIAL_STATE: MutationAuthorityContractState =
  Object.freeze({
    primary: 0,
    secondary: 0,
    rollbackOnly: 0,
    revisions: { primary: 0, secondary: 0, rollbackOnly: 0 },
    effects: [],
  })

function authorityEnvelope(
  sequence: number,
  args: AuthorityContractArgs
): MutationEnvelope<{
  readonly name: typeof MUTATION_AUTHORITY_CONTRACT_MUTATION
  readonly args: AuthorityContractArgs
}> {
  return {
    protocol: MUTATION_AUTHORITY_CONTRACT_PROTOCOL,
    mutationId: `00000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`,
    invocation: { name: MUTATION_AUTHORITY_CONTRACT_MUTATION, args },
  }
}

function contractArgs(
  overrides: Partial<AuthorityContractArgs> = {}
): AuthorityContractArgs {
  return {
    amount: 1,
    axes: ["primary"],
    behavior: "accept",
    effect: "effect",
    maximumPrimary: null,
    ...overrides,
  }
}

function advanceContractState(
  current: MutationAuthorityContractState,
  args: AuthorityContractArgs
): {
  readonly next: MutationAuthorityContractState
  readonly stamped: readonly [AxisId, Revision][]
} {
  let primary = current.primary
  let secondary = current.secondary
  let rollbackOnly = current.rollbackOnly
  let primaryRevision = current.revisions.primary
  let secondaryRevision = current.revisions.secondary
  let rollbackRevision = current.revisions.rollbackOnly
  const stamped: [AxisId, Revision][] = []

  for (const axis of args.axes) {
    if (axis === "primary") {
      primary += args.amount
      primaryRevision += 1
      stamped.push([PRIMARY_AXIS, primaryRevision as Revision])
    } else if (axis === "secondary") {
      secondary += args.amount
      secondaryRevision += 1
      stamped.push([SECONDARY_AXIS, secondaryRevision as Revision])
    } else if (current.primary === 0) {
      rollbackOnly += args.amount
      rollbackRevision += 1
      stamped.push([ROLLBACK_AXIS, rollbackRevision as Revision])
    }
  }

  return {
    next: {
      primary,
      secondary,
      rollbackOnly,
      revisions: {
        primary: primaryRevision,
        secondary: secondaryRevision,
        rollbackOnly: rollbackRevision,
      },
      effects: [...current.effects, args.effect],
    },
    stamped,
  }
}

/** A ready-to-run in-memory harness for `verifyMutationAuthorityContract`. */
export function createInMemoryMutationAuthorityContractHarness(): MutationAuthorityContractHarness {
  return {
    name: "in-memory",
    create() {
      const authority = createInMemoryMutationAuthority<
        MutationAuthorityContractState,
        string,
        MutationAuthorityContractRejection
      >({
        initialState: MUTATION_AUTHORITY_CONTRACT_INITIAL_STATE,
        scope: (actor) => actor,
      })
      const execute = async (envelope: unknown) => {
        const prepared = await prepareMutationRequest(
          mutationAuthorityContractProtocol,
          envelope
        )
        if (!prepared.ok) return prepared

        return executePreparedMutation({
          prepared: prepared.value,
          actor: MUTATION_AUTHORITY_CONTRACT_ACTOR,
          authority,
          async run(tx, stamp, rawArgs) {
            const args = rawArgs as AuthorityContractArgs
            const current = tx.read()
            if (
              args.maximumPrimary !== null &&
              current.primary > args.maximumPrimary
            ) {
              return err({
                kind: "refused",
                error: { code: "precondition" },
              } as const)
            }

            const advanced = advanceContractState(current, args)
            tx.write(advanced.next)
            for (const [axis, stampedRevision] of advanced.stamped) {
              stamp.record(axis, stampedRevision)
            }

            if (
              args.behavior === "mutate-args-when-zero" &&
              current.primary === 0
            ) {
              const mutableArgs = args as { amount: number }
              mutableArgs.amount = 100
            }

            if (args.behavior === "throw") {
              throw new Error("authority contract exception")
            }
            if (args.behavior === "reject") {
              return err({
                kind: "refused",
                error: { code: "rejected-after-write" },
              } as const)
            }
            return ok(undefined)
          },
        })
      }

      return {
        execute,
        read: async () => authority.read(),
        replace: async (next) => authority.replace(next),
        contendNext: async (primaryDelta = 0) => {
          authority.contendNext((current) => ({
            ...current,
            primary: current.primary + primaryDelta,
            revisions: {
              ...current.revisions,
              primary: current.revisions.primary + (primaryDelta === 0 ? 0 : 1),
            },
          }))
        },
        receiptCount: async () => authority.receiptCount(),
        hasReceipt: async (mutationId) =>
          authority.hasReceipt(MUTATION_AUTHORITY_CONTRACT_ACTOR, mutationId),
        attemptCount: async (mutationId) =>
          authority.attemptCount(MUTATION_AUTHORITY_CONTRACT_ACTOR, mutationId),
      }
    },
  }
}

function requireTerminal<Rejection>(
  result: Result<MutationTerminalOutcome<Rejection>, MutationExecutorError>
): MutationTerminalOutcome<Rejection> {
  if (!result.ok) {
    throw new Error(`Expected terminal outcome, received ${result.error.code}`)
  }
  return result.value
}

function requireAccepted<Rejection>(
  result: Result<MutationTerminalOutcome<Rejection>, MutationExecutorError>
): AcceptedStamp {
  const terminal = requireTerminal(result)
  if (terminal.kind !== "accepted") {
    throw new Error("Expected accepted authority outcome")
  }
  return terminal.stamp
}

export function assertMutationAuthorityContractAccumulation(
  stamp: AcceptedStamp,
  state: MutationAuthorityContractState
): void {
  expect(stamp.revisions).toEqual({
    [PRIMARY_AXIS]: 1,
    [SECONDARY_AXIS]: 1,
  })
  expect(state).toMatchObject({
    primary: 1,
    secondary: 1,
    effects: ["multi-axis"],
  })
}

export function assertMutationAuthorityContractRollback(
  state: MutationAuthorityContractState
): void {
  expect(state).toEqual(MUTATION_AUTHORITY_CONTRACT_INITIAL_STATE)
}

/** Runs the reusable black-box authority contract against one adapter fixture. */
export function verifyMutationAuthorityContract(
  harness: MutationAuthorityContractHarness
): void {
  describe(`${harness.name} mutation authority contract`, () => {
    it("rejects client revision claims outside the admitted envelope", async () => {
      const driver = await harness.create()
      const envelope = {
        ...authorityEnvelope(1, contractArgs()),
        expectedRevision: 0,
      }

      await expect(driver.execute(envelope)).resolves.toEqual(
        err({ code: "invalid-envelope", reason: "unexpected-fields" })
      )
      expect(await driver.receiptCount()).toBe(0)
    })

    it("runs replayable and preconditioned commands against current authority", async () => {
      const driver = await harness.create()
      await driver.replace({
        ...MUTATION_AUTHORITY_CONTRACT_INITIAL_STATE,
        primary: 5,
        revisions: {
          ...MUTATION_AUTHORITY_CONTRACT_INITIAL_STATE.revisions,
          primary: 4,
        },
      })

      const replayable = authorityEnvelope(
        2,
        contractArgs({ amount: 2, effect: "current-authority" })
      )
      requireAccepted(await driver.execute(replayable))
      expect(await driver.read()).toMatchObject({
        primary: 7,
        effects: ["current-authority"],
      })

      const preconditioned = authorityEnvelope(
        3,
        contractArgs({ maximumPrimary: 6, effect: "must-not-run" })
      )
      expect(requireTerminal(await driver.execute(preconditioned))).toEqual({
        kind: "rejected",
        error: { code: "precondition" },
      })
      expect((await driver.read()).effects).toEqual(["current-authority"])
    })

    it("reruns load and handler after one CAS loss without retaining attempt effects", async () => {
      const driver = await harness.create()
      const envelope = authorityEnvelope(
        4,
        contractArgs({ amount: 2, effect: "once-after-retry" })
      )
      await driver.contendNext(10)

      const stamp = requireAccepted(await driver.execute(envelope))

      expect(await driver.read()).toMatchObject({
        primary: 12,
        effects: ["once-after-retry"],
      })
      expect(stamp.revisions[PRIMARY_AXIS]).toBe(2)
      expect(await driver.attemptCount(envelope.mutationId)).toBe(2)
    })

    it("gives every contention attempt fresh canonical arguments", async () => {
      const driver = await harness.create()
      const envelope = authorityEnvelope(
        14,
        contractArgs({
          behavior: "mutate-args-when-zero",
          effect: "fresh-arguments",
        })
      )
      await driver.contendNext(10)

      requireAccepted(await driver.execute(envelope))

      expect(await driver.read()).toMatchObject({
        primary: 11,
        effects: ["fresh-arguments"],
      })
      expect(await driver.attemptCount(envelope.mutationId)).toBe(2)
    })

    it("discards a rolled-back attempt's stamp entries", async () => {
      const driver = await harness.create()
      const envelope = authorityEnvelope(
        5,
        contractArgs({
          axes: ["primary", "rollback-when-zero"],
          effect: "rollback-stamp",
        })
      )
      await driver.contendNext(10)

      const stamp = requireAccepted(await driver.execute(envelope))

      expect(stamp.revisions).toEqual({ [PRIMARY_AXIS]: 2 })
      expect(await driver.read()).toMatchObject({
        primary: 11,
        rollbackOnly: 0,
        effects: ["rollback-stamp"],
      })
    })

    it("records every committed axis atomically in the accepted vector", async () => {
      const driver = await harness.create()
      const envelope = authorityEnvelope(
        6,
        contractArgs({
          axes: ["primary", "secondary"],
          effect: "multi-axis",
        })
      )

      const stamp = requireAccepted(await driver.execute(envelope))

      assertMutationAuthorityContractAccumulation(stamp, await driver.read())
    })

    it("rolls back partial handler work before recording a terminal rejection", async () => {
      const driver = await harness.create()
      const envelope = authorityEnvelope(
        7,
        contractArgs({ behavior: "reject", effect: "rolled-back" })
      )

      const first = requireTerminal(await driver.execute(envelope))
      const duplicate = requireTerminal(await driver.execute(envelope))

      expect(first).toEqual({
        kind: "rejected",
        error: { code: "rejected-after-write" },
      })
      expect(duplicate).toEqual(first)
      assertMutationAuthorityContractRollback(await driver.read())
      expect(await driver.attemptCount(envelope.mutationId)).toBe(1)
      expect(await driver.hasReceipt(envelope.mutationId)).toBe(true)
    })

    it("isolates a recorded rejection from caller mutation", async () => {
      const driver = await harness.create()
      const envelope = authorityEnvelope(
        13,
        contractArgs({ behavior: "reject", effect: "immutable-receipt" })
      )

      const first = requireTerminal(await driver.execute(envelope))
      if (first.kind !== "rejected") {
        throw new Error("Expected contract rejection")
      }
      const callerOwnedError = first.error as { code: string }
      callerOwnedError.code = "caller-corruption"

      expect(requireTerminal(await driver.execute(envelope))).toEqual({
        kind: "rejected",
        error: { code: "rejected-after-write" },
      })
    })

    it("returns recorded duplicates without rerunning and rejects ID collisions", async () => {
      const driver = await harness.create()
      const envelope = authorityEnvelope(
        8,
        contractArgs({ effect: "deduplicated" })
      )
      const first = await driver.execute(envelope)
      const duplicate = await driver.execute(structuredClone(envelope))
      const collision = await driver.execute({
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
      expect((await driver.read()).effects).toEqual(["deduplicated"])
      expect(await driver.attemptCount(envelope.mutationId)).toBe(1)
    })

    it("collapses concurrent delivery of one mutation ID to one effect", async () => {
      const driver = await harness.create()
      const envelope = authorityEnvelope(
        12,
        contractArgs({ effect: "concurrent-deduplication" })
      )

      const [first, second] = await Promise.all([
        driver.execute(envelope),
        driver.execute(structuredClone(envelope)),
      ])

      expect(second).toEqual(first)
      expect((await driver.read()).effects).toEqual([
        "concurrent-deduplication",
      ])
      expect(await driver.attemptCount(envelope.mutationId)).toBe(1)
    })

    it("treats differently ordered object keys as the same canonical invocation", async () => {
      const driver = await harness.create()
      const envelope = authorityEnvelope(
        9,
        contractArgs({ effect: "canonical-order" })
      )
      const reorderedArgs = {
        maximumPrimary: envelope.invocation.args.maximumPrimary,
        effect: envelope.invocation.args.effect,
        behavior: envelope.invocation.args.behavior,
        axes: envelope.invocation.args.axes,
        amount: envelope.invocation.args.amount,
      }

      const first = await driver.execute(envelope)
      const duplicate = await driver.execute({
        ...envelope,
        invocation: {
          name: MUTATION_AUTHORITY_CONTRACT_MUTATION,
          args: reorderedArgs,
        },
      })

      expect(duplicate).toEqual(first)
      expect(await driver.attemptCount(envelope.mutationId)).toBe(1)
    })

    it("stores no receipt after exhausted contention and preserves the mutation ID", async () => {
      const driver = await harness.create()
      const envelope = authorityEnvelope(
        10,
        contractArgs({ effect: "retry-same-id" })
      )
      await driver.contendNext(1)
      await driver.contendNext(1)

      expect(await driver.execute(envelope)).toEqual(
        err({ code: "contention", mutationId: envelope.mutationId })
      )
      expect(await driver.hasReceipt(envelope.mutationId)).toBe(false)
      expect((await driver.read()).effects).toEqual([])

      requireAccepted(await driver.execute(envelope))
      expect(await driver.hasReceipt(envelope.mutationId)).toBe(true)
      expect((await driver.read()).effects).toEqual(["retry-same-id"])
    })

    it("rolls back unexpected exceptions without recording a receipt", async () => {
      const driver = await harness.create()
      const envelope = authorityEnvelope(
        11,
        contractArgs({ behavior: "throw", effect: "exception" })
      )

      await expect(driver.execute(envelope)).rejects.toThrow(
        "authority contract exception"
      )
      expect(await driver.read()).toEqual(
        MUTATION_AUTHORITY_CONTRACT_INITIAL_STATE
      )
      expect(await driver.hasReceipt(envelope.mutationId)).toBe(false)
    })
  })
}

export interface InvalidationContractFixture {
  readonly adapter: InvalidationAdapter
  readonly publisher: InvalidationPublisher
  readonly published: () => readonly AxisInvalidation[]
  readonly settled: () => Promise<void>
}

export interface InvalidationContractHarness {
  readonly name: string
  create(): InvalidationContractFixture | Promise<InvalidationContractFixture>
}

/** A ready-to-run in-memory harness for `verifyInvalidationContract`. */
export function createInMemoryInvalidationContractHarness(): InvalidationContractHarness {
  return {
    name: "in-memory",
    create() {
      const invalidations = createInMemoryInvalidationAdapter()
      return {
        adapter: invalidations,
        publisher: invalidations,
        published: () => invalidations.published,
        settled: async () => undefined,
      }
    },
  }
}

const INVALIDATION_AXIS_A = axisId("headcanon/invalidation-contract/a")
const INVALIDATION_AXIS_B = axisId("headcanon/invalidation-contract/b")
const INVALIDATION_AXIS_UNRELATED = axisId(
  "headcanon/invalidation-contract/unrelated"
)

function invalidationVector(entries: Record<string, number>): RevisionVector {
  const parsed = revisionVector(entries)
  if (!parsed.ok) throw new Error("Invalid invalidation contract vector")
  return parsed.value
}

function invalidationCanon(
  a: number,
  b: number
): Canon<{ readonly a: number; readonly b: number }> {
  return {
    value: { a, b },
    revisions: invalidationVector({
      [INVALIDATION_AXIS_A]: a,
      [INVALIDATION_AXIS_B]: b,
    }),
  }
}

function invalidationStamp(entries: Record<string, number>): AcceptedStamp {
  return acceptedStamp(invalidationVector(entries))
}

/** Runs the reusable black-box invalidation contract against one adapter. */
export function verifyInvalidationContract(
  harness: InvalidationContractHarness
): void {
  describe(`${harness.name} invalidation contract`, () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it("isolates axes, publishes singleton entries, and cleans up subscriptions", async () => {
      const fixture = await harness.create()
      const a = vi.fn()
      const b = vi.fn()
      const unrelated = vi.fn()
      const stopA = fixture.adapter.subscribe({
        axes: [INVALIDATION_AXIS_A],
        onInvalidation: a,
        onStatusChange: vi.fn(),
      })
      fixture.adapter.subscribe({
        axes: [INVALIDATION_AXIS_B],
        onInvalidation: b,
        onStatusChange: vi.fn(),
      })
      fixture.adapter.subscribe({
        axes: [INVALIDATION_AXIS_UNRELATED],
        onInvalidation: unrelated,
        onStatusChange: vi.fn(),
      })
      await fixture.settled()

      await fixture.publisher.publish(
        "shared-event",
        invalidationStamp({
          [INVALIDATION_AXIS_A]: 1,
          [INVALIDATION_AXIS_B]: 2,
        })
      )

      expect(a).toHaveBeenCalledExactlyOnceWith({
        eventId: "shared-event",
        axis: INVALIDATION_AXIS_A,
        revision: 1,
      })
      expect(b).toHaveBeenCalledExactlyOnceWith({
        eventId: "shared-event",
        axis: INVALIDATION_AXIS_B,
        revision: 2,
      })
      expect(unrelated).not.toHaveBeenCalled()
      expect(fixture.published()).toEqual([
        {
          eventId: "shared-event",
          axis: INVALIDATION_AXIS_A,
          revision: 1,
        },
        {
          eventId: "shared-event",
          axis: INVALIDATION_AXIS_B,
          revision: 2,
        },
      ])
      expect(
        fixture
          .published()
          .every((entry) =>
            Object.keys(entry).every((key) =>
              ["eventId", "axis", "revision"].includes(key)
            )
          )
      ).toBe(true)

      stopA()
      await fixture.publisher.publish(
        "after-unsubscribe",
        invalidationStamp({ [INVALIDATION_AXIS_A]: 3 })
      )
      expect(a).toHaveBeenCalledTimes(1)
    })

    it("ingests every axis in one event before requesting one coalesced refresh", async () => {
      const fixture = await harness.create()
      const request = vi.fn(async () => undefined)
      const refresh: RefreshAdapter = { acceptanceGraceMs: 0, request }
      const rendered = renderHook(
        ({
          canon,
        }: {
          readonly canon: Canon<{ readonly a: number; readonly b: number }>
        }) => useIncorporation(canon, refresh, fixture.adapter),
        { initialProps: { canon: invalidationCanon(0, 0) } }
      )
      await fixture.settled()
      await flushMicrotasks()
      request.mockClear()

      await act(async () => {
        await fixture.publisher.publish(
          "shared-event",
          invalidationStamp({
            [INVALIDATION_AXIS_A]: 1,
            [INVALIDATION_AXIS_B]: 1,
          })
        )
      })
      await flushMicrotasks()
      expect(request).toHaveBeenCalledTimes(1)

      rendered.rerender({
        canon: {
          value: { a: 1, b: 0 },
          revisions: invalidationVector({
            [INVALIDATION_AXIS_A]: 1,
            [INVALIDATION_AXIS_B]: 0,
          }),
        },
      })
      await flushMicrotasks()
      await advance(1_000)

      expect(request).toHaveBeenCalledTimes(2)
      rendered.unmount()
    })

    it("deduplicates duplicate and older revisions monotonically per axis", async () => {
      const fixture = await harness.create()
      const request = vi.fn(async () => undefined)
      const refresh: RefreshAdapter = { acceptanceGraceMs: 0, request }
      const rendered = renderHook(() =>
        useIncorporation(invalidationCanon(0, 0), refresh, fixture.adapter)
      )
      await fixture.settled()
      await flushMicrotasks()
      request.mockClear()

      await act(async () => {
        await fixture.publisher.publish(
          "newest",
          invalidationStamp({ [INVALIDATION_AXIS_A]: 2 })
        )
        await fixture.publisher.publish(
          "duplicate",
          invalidationStamp({ [INVALIDATION_AXIS_A]: 2 })
        )
        await fixture.publisher.publish(
          "older",
          invalidationStamp({ [INVALIDATION_AXIS_A]: 1 })
        )
      })
      await flushMicrotasks()

      expect(request).toHaveBeenCalledTimes(1)
      rendered.unmount()
    })

    it("suppresses an own-write echo after terminal acceptance", async () => {
      const fixture = await harness.create()
      const request = vi.fn()
      const refresh: RefreshAdapter = { acceptanceGraceMs: 250, request }
      const rendered = renderHook(() =>
        useIncorporation(invalidationCanon(0, 0), refresh, fixture.adapter)
      )
      await fixture.settled()
      await flushMicrotasks()
      request.mockClear()
      const ownStamp = invalidationStamp({ [INVALIDATION_AXIS_A]: 1 })

      act(() => rendered.result.current.recordAcceptance("own-write", ownStamp))
      await act(async () => {
        await fixture.publisher.publish("own-write-event", ownStamp)
      })
      await flushMicrotasks()

      expect(rendered.result.current.status.freshness).toBe("grace")
      expect(request).not.toHaveBeenCalled()
      rendered.unmount()
    })
  })
}

export function verifyPollingFallbackContract(): void {
  describe("polling fallback contract", () => {
    let visibility: DocumentVisibilityState
    let originalVisibility: PropertyDescriptor | undefined

    const setVisibility = (next: DocumentVisibilityState) => {
      visibility = next
      document.dispatchEvent(new Event("visibilitychange"))
    }

    beforeEach(() => {
      vi.useFakeTimers()
      visibility = "visible"
      originalVisibility = Object.getOwnPropertyDescriptor(
        document,
        "visibilityState"
      )
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => visibility,
      })
    })

    afterEach(() => {
      if (originalVisibility) {
        Object.defineProperty(document, "visibilityState", originalVisibility)
      } else {
        Reflect.deleteProperty(document, "visibilityState")
      }
      vi.useRealTimers()
    })

    it("reports polling and serializes refreshes while the primary is unavailable", async () => {
      const primary = createInMemoryInvalidationAdapter()
      primary.setStatus("unavailable")
      const invalidations = withPollingFallback(primary, { intervalMs: 100 })
      const completions: Array<() => void> = []
      const request = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            completions.push(resolve)
          })
      )
      const refresh: RefreshAdapter = { acceptanceGraceMs: 0, request }
      const rendered = renderHook(() =>
        useIncorporation(contractCanon(0), refresh, invalidations)
      )

      expect(rendered.result.current.status.invalidations).toBe("polling")
      await advance(400)
      expect(request).toHaveBeenCalledTimes(1)

      act(() => completions.shift()?.())
      await flushMicrotasks()
      expect(request).toHaveBeenCalledTimes(2)

      await advance(400)
      act(() => primary.setStatus("active"))
      act(() => completions.shift()?.())
      await flushMicrotasks()
      expect(request).toHaveBeenCalledTimes(2)
      rendered.unmount()
    })

    it("pauses while hidden and refreshes immediately when visibility resumes", async () => {
      const primary = createInMemoryInvalidationAdapter()
      primary.setStatus("unavailable")
      setVisibility("hidden")
      const request = vi.fn(async () => undefined)
      const refresh: RefreshAdapter = { acceptanceGraceMs: 0, request }
      const rendered = renderHook(() =>
        useIncorporation(
          contractCanon(0),
          refresh,
          withPollingFallback(primary, { intervalMs: 100 })
        )
      )

      await advance(500)
      expect(request).not.toHaveBeenCalled()

      act(() => setVisibility("visible"))
      await flushMicrotasks()
      expect(request).toHaveBeenCalledTimes(1)

      await advance(100)
      expect(request).toHaveBeenCalledTimes(2)

      act(() => setVisibility("hidden"))
      await advance(500)
      expect(request).toHaveBeenCalledTimes(2)
      rendered.unmount()
    })

    it("polls during initial reauthorization and stops when the primary recovers", async () => {
      const primary = createInMemoryInvalidationAdapter()
      primary.setStatus("reauthorizing")
      const request = vi.fn(async () => undefined)
      const refresh: RefreshAdapter = { acceptanceGraceMs: 0, request }
      const rendered = renderHook(() =>
        useIncorporation(
          contractCanon(0),
          refresh,
          withPollingFallback(primary, { intervalMs: 100 })
        )
      )

      expect(rendered.result.current.status.invalidations).toBe("polling")
      await advance(100)
      expect(request).toHaveBeenCalledTimes(1)

      act(() => primary.setStatus("active"))
      expect(rendered.result.current.status.invalidations).toBe("active")
      await advance(500)
      expect(request).toHaveBeenCalledTimes(1)
      rendered.unmount()
    })

    it("supports intentional no-realtime roots and cancels on unmount", async () => {
      const request = vi.fn(async () => undefined)
      const refresh: RefreshAdapter = { acceptanceGraceMs: 0, request }
      const invalidations = withPollingFallback(
        createNoRealtimeInvalidationAdapter(),
        { intervalMs: 100 }
      )
      const rendered = renderHook(() =>
        useIncorporation(contractCanon(0), refresh, invalidations)
      )

      expect(rendered.result.current.status.invalidations).toBe("polling")
      rendered.unmount()
      await advance(500)
      act(() => setVisibility("hidden"))
      act(() => setVisibility("visible"))
      await flushMicrotasks()
      expect(request).not.toHaveBeenCalled()
    })
  })
}

export interface RefreshContractHarness {
  readonly name: string
  readonly completion: "canon" | "request"
  readonly useRefresh: (request: () => void | Promise<void>) => RefreshAdapter
}

const contractAxis = axisId("headcanon/refresh-contract")

function contractCanon(revision: number): Canon<number> {
  const parsed = revisionVector({ [contractAxis]: revision })
  if (!parsed.ok) throw new Error("Invalid refresh contract canon")
  return { value: revision, revisions: parsed.value }
}

function contractStamp(revision: number) {
  const parsed = revisionVector({ [contractAxis]: revision })
  if (!parsed.ok) throw new Error("Invalid refresh contract stamp")
  return acceptedStamp(parsed.value)
}

async function flushMicrotasks() {
  await act(async () => Promise.resolve())
}

async function advance(ms: number) {
  await act(async () => vi.advanceTimersByTimeAsync(ms))
}

function setupRefreshContract(harness: RefreshContractHarness) {
  const request = vi.fn()
  const useRefresh = harness.useRefresh
  let acceptanceGraceMs = 0
  const rendered = renderHook(
    ({ currentCanon }: { readonly currentCanon: Canon<number> }) => {
      const refresh = useRefresh(request)
      acceptanceGraceMs = refresh.acceptanceGraceMs
      return useIncorporation(currentCanon, refresh)
    },
    { initialProps: { currentCanon: contractCanon(0) } }
  )

  act(() =>
    rendered.result.current.recordAcceptance(
      "refresh-contract-mutation",
      contractStamp(1)
    )
  )

  return { ...rendered, acceptanceGraceMs, request }
}

export function assertRefreshContractStalled(
  status: Pick<IncorporationStatus, "freshness" | "stallReason">
): void {
  expect(status).toMatchObject({
    freshness: "stalled",
    stallReason: "behind",
  })
}

async function completeAttempt(
  harness: RefreshContractHarness,
  rendered: ReturnType<typeof setupRefreshContract>
) {
  if (harness.completion === "canon") {
    rendered.rerender({ currentCanon: contractCanon(0) })
  }
  await flushMicrotasks()
}

export function verifyRefreshContract(harness: RefreshContractHarness): void {
  describe(`${harness.name} refresh contract`, () => {
    it("honors carrier grace and stalls after two uncovered refreshes", async () => {
      const rendered = setupRefreshContract(harness)
      const { acceptanceGraceMs, result, request } = rendered

      await flushMicrotasks()
      if (acceptanceGraceMs > 0) {
        expect(result.current.status.freshness).toBe("grace")
        expect(request).not.toHaveBeenCalled()
        await advance(acceptanceGraceMs)
      }

      expect(request).toHaveBeenCalledTimes(1)
      await completeAttempt(harness, rendered)
      await advance(1_000)

      expect(request).toHaveBeenCalledTimes(2)
      await completeAttempt(harness, rendered)
      assertRefreshContractStalled(result.current.status)
    })

    it("gives manual retry a fresh two-attempt budget", async () => {
      const rendered = setupRefreshContract(harness)
      const { acceptanceGraceMs, result, request } = rendered

      await flushMicrotasks()
      if (acceptanceGraceMs > 0) await advance(acceptanceGraceMs)
      await completeAttempt(harness, rendered)
      await advance(1_000)
      await completeAttempt(harness, rendered)
      expect(result.current.status.freshness).toBe("stalled")

      act(() => result.current.retryRefresh())
      await flushMicrotasks()
      expect(request).toHaveBeenCalledTimes(3)
      await completeAttempt(harness, rendered)

      await advance(1_000)
      expect(request).toHaveBeenCalledTimes(4)
      await completeAttempt(harness, rendered)
      expect(result.current.status.freshness).toBe("stalled")
    })
  })
}
