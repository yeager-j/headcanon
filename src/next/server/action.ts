import type { StandardSchemaV1 } from "@standard-schema/spec"
import { refresh, updateTag } from "next/cache"
import { ok, type Result } from "serializable-result"

import {
  executePreparedMutation,
  prepareMutationRequest,
  type AttemptDecision,
  type MutationAuthorityAdapter,
  type MutationExecutorError,
  type MutationTerminalOutcome,
  type PreparedMutationRequest,
  type ProtocolIdentity,
  type RecordedTerminalOutcome,
  type StampAccumulator,
} from "../../core/authority"
import type { InvalidationPublisher } from "../../core/invalidation"
import {
  operationRegistry,
  type AnyOperationDefinition,
  type OperationActionOutcome,
  type OperationRefusalOf,
} from "../../core/operation"
import {
  isCheckedMutation,
  isUnchanged,
  type AnyMutationDefinition,
  type AnyProtocolDefinition,
  type MutationContext,
  type MutationRefusalOf,
} from "../../core/protocol"
import type { AcceptedStamp } from "../../core/revisions"
import {
  assertValidBindings,
  type AnyMutationBinding,
  type BoundMutation,
  type MutationBinder,
  type MutationBinding,
  type MutationCommand,
  type OperationBinding,
  type OperationCommand,
  type ValidBindings,
} from "../../server/binder"
import {
  acceptMutation,
  refuseMutation,
  type MutationAdmission,
  type MutationScreening,
} from "../../server/outcomes"
import { parseStoredValue } from "../../server/refusal"
import { finalizeStamp } from "./revalidation"

/**
 * The erased form the action dispatches through once the binding list has
 * been checked: any parsed args and the protocol's refusal union.
 */
type RuntimeMutation<Refusal> = AnyMutationDefinition &
  ((args: unknown) => unknown) & {
    readonly refusal: StandardSchemaV1<unknown, Refusal>
  }

type RuntimeBinding<Actor, Preflight, Transaction, Refusal> = MutationBinding<
  RuntimeMutation<Refusal>,
  MutationCommand<
    RuntimeMutation<Refusal>,
    Actor,
    Preflight,
    Transaction,
    unknown,
    unknown
  >
>

/**
 * Creates one Server Action from a binder and an exhaustive, definition-keyed
 * command list.
 *
 * The binder supplies the trusted actor and the authority. Every binding in
 * `commands` must be made by that same binder object; the action rejects a
 * binding from another binder when it is created, even one with the same
 * types. `commands` must be one fixed list that binds every protocol mutation
 * exactly once. The compiler checks this, and the action checks it again when
 * it is created. Write the list inline, or declare it elsewhere with
 * `as const`. Do not choose the list, or one of its entries, with a
 * condition: the compiler rejects a union of lists or of bindings instead of
 * guessing which one runs.
 *
 * The returned action treats its argument as untrusted: a malformed or unknown
 * envelope returns an executor error before the binder's actor callback or any
 * command runs. After it derives the actor, it denies an envelope whose
 * `scope` is not the authority's `scope(actor)`, before any receipt lookup or
 * command. It runs `screen` before it claims a receipt, and runs `admit`
 * and `execute` inside the authority's transaction attempts, which may repeat.
 * For a mutation defined by `check` and `apply`, it runs `check` over the
 * state `admit` returned, and runs `execute` only when `check` returns an
 * effect: a refusal is recorded, and `unchanged()` accepts with an empty
 * stamp.
 * When no receipt exists and the envelope's `createdAt` is outside the
 * authority's delivery window, it returns `delivery-expired` or
 * `delivery-from-future` after `screen`, without admitting or recording it.
 * `screen` and `finalizeAccepted` each receive their own copy of the parsed
 * arguments; `admit` and `execute` share one fresh copy per attempt. The
 * authority owns receipt deduplication and contention; commands own
 * application authorization, domain writes, axis stamping, and the
 * repeat-safe `finalizeAccepted` projection.
 *
 * A denial, from the scope check, from screening, or from a recorded
 * transaction-time admission, returns `ok({ kind: "denied" })`. It carries no
 * reason, so it reveals no more than an HTTP 403, and it needs no Next
 * configuration. A scope or screening denial claims no receipt; a recorded
 * denial replays on redelivery.
 *
 * After acceptance the action first runs `finalizeAccepted`, then expires
 * the affected Next cache tags, refreshes the invoking route, and publishes
 * invalidations. That order lets a projection write what readers load before
 * any reader is told to reload. If `finalizeAccepted` throws, the action still
 * expires, refreshes, and publishes, because the commit exists, and then
 * rethrows; a redelivery recovers the stored receipt and reruns the
 * projection, so accepted finalization is at-least-once. Publication failures
 * go only to the publisher's `onFailure` reporter and do not turn an accepted
 * mutation into a rejection. Omit `invalidations` when the application has no
 * realtime transport: the action then only expires tags and refreshes, and
 * the router carries canon back.
 *
 * @param options Protocol, binder, exhaustive commands made by that binder, and optionally an invalidation publisher.
 * @returns A protocol-branded Server Action returning terminal outcomes (`accepted`, `refused`, or `denied`) or typed executor failures.
 * @throws Error at creation when a binding is duplicated, uses another definition, was made by another binder, or the list is incomplete.
 * @throws Error when a command accepts with an empty stamp without `acceptMutation({ unchanged: true })`, or records an axis with it; the attempt rolls back and no receipt is recorded.
 * @throws Trusted actor or command callbacks may throw unexpected application/framework failures.
 */
export function createNextMutationAction<
  const Protocol extends AnyProtocolDefinition,
  Transaction,
  Actor,
  Preflight,
  const Commands extends readonly AnyMutationBinding[],
>(options: {
  readonly protocol: Protocol
  readonly binder: MutationBinder<Transaction, Actor, Preflight>
  readonly commands: Commands &
    ValidBindings<Protocol, Commands, Actor, Preflight, Transaction>
  /** Publishes accepted stamps to other clients; omit it without realtime. */
  readonly invalidations?: InvalidationPublisher
}) {
  type Refusal = MutationRefusalOf<BoundMutation<Commands>>
  type Terminal = MutationTerminalOutcome<Refusal>

  const { binder } = options
  assertValidBindings(options.protocol, binder, options.commands)
  const bindings = new Map(
    options.commands.map((binding) => [
      binding.mutation.name,
      binding as RuntimeBinding<Actor, Preflight, Transaction, Refusal>,
    ])
  )

  // The phantom ProtocolIdentity pairs this generated action with its
  // protocol at the type level: the envelope parameter is `unknown` (strict
  // admission), so it provides no protocol evidence. The tag stops a client
  // binding a refusal-compatible foreign action.
  return async (
    envelope: unknown
  ): Promise<
    Result<Terminal, MutationExecutorError> & ProtocolIdentity<Protocol["id"]>
  > => {
    const prepared = await prepareMutationRequest(options.protocol, envelope)
    if (!prepared.ok) return prepared

    const binding = bindings.get(prepared.value.mutation)
    if (!binding) {
      throw new Error(`Missing mutation binding: ${prepared.value.mutation}`)
    }

    return deliverCommand<Transaction, Actor, Preflight, Refusal>({
      prepared: prepared.value,
      binder,
      command: deliveredMutationCommand(binding),
      parseRefusal: (value) =>
        parseStoredValue<Refusal>(
          binding.mutation.refusal,
          value,
          "Mutation refusal"
        ),
      invalidations: options.invalidations,
    })
  }
}

/**
 * Creates one Server Action for one operation: a write outside a protocol
 * whose receipt makes every delivery of one submission commit at most once.
 *
 * The binding must be made by `binder`; the action rejects one from another
 * binder when it is created. Each call parses its untrusted envelope, derives
 * the actor, screens, and runs `admit` and `execute` in the authority's
 * transaction attempts, exactly as `createNextMutationAction` does. Receipts,
 * the scope check, the delivery window, denials, and contention work the
 * same way. A redelivery of a recorded submission runs `screen` and returns
 * the recorded outcome, result included, without running the command again;
 * the same mutation ID with other arguments returns `mutation-id-reused`.
 *
 * After acceptance the action runs `finalizeAccepted` with the recorded
 * result, then expires the stamp's cache tags, refreshes the invoking route,
 * and publishes invalidations, also when the outcome is recovered from a
 * receipt. To redirect from the server, wrap the action and call Next's
 * `redirect()` after an accepted outcome.
 * @param options The binder, one operation binding made by it, and optionally an invalidation publisher.
 * @returns An operation-branded Server Action returning terminal outcomes (`accepted` with the result, `refused`, or `denied`) or typed executor failures.
 * @throws Error at creation when the binding was made by another binder.
 * @throws Error when a command's acceptance does not match its stamp, or its result does not match the result schema; the attempt rolls back and no receipt is recorded.
 * @example
 * ```ts
 * "use server"
 * export const createRunAction = createNextOperationAction({
 *   binder: runsBinder,
 *   binding: createRunBinding,
 * })
 * ```
 */
export function createNextOperationAction<
  const Operation extends AnyOperationDefinition,
  Transaction,
  Actor,
  Preflight,
  Screened,
  Evidence,
>(options: {
  readonly binder: MutationBinder<Transaction, Actor, Preflight>
  readonly binding: OperationBinding<
    Operation,
    OperationCommand<
      Operation,
      Actor,
      Preflight,
      Transaction,
      Screened,
      Evidence
    >
  >
  /** Publishes accepted stamps to other clients; omit it without realtime. */
  readonly invalidations?: InvalidationPublisher
}) {
  type Refusal = OperationRefusalOf<Operation>

  const { binder, binding } = options
  if (binding.binder !== binder) {
    throw new Error(
      `Operation binding was made by another binder: ${binding.operation.name}`
    )
  }
  const registry = operationRegistry(binding.operation)

  return async (
    envelope: unknown
  ): Promise<OperationActionOutcome<Operation>> => {
    const prepared = await prepareMutationRequest(registry, envelope)
    if (!prepared.ok) return prepared

    const outcome = await deliverCommand<
      Transaction,
      Actor,
      Preflight,
      Refusal
    >({
      prepared: prepared.value,
      binder,
      command: binding.command as DeliveredCommand<
        Transaction,
        Actor,
        Preflight,
        Refusal
      >,
      parseRefusal: (value) =>
        parseStoredValue<Refusal>(
          binding.operation.refusal,
          value,
          "Mutation refusal"
        ),
      parseResult: (value) =>
        parseStoredValue(binding.operation.result, value, "Operation result"),
      invalidations: options.invalidations,
    })
    // `parseResult` gives every accepted outcome its parsed result.
    return outcome as OperationActionOutcome<Operation>
  }
}

/** The erased command shape the shared delivery runs, for a mutation or an operation. */
interface DeliveredCommand<Transaction, Actor, Preflight, Refusal> {
  readonly screen: (context: {
    readonly executor: Preflight
    readonly actor: Actor
    readonly args: unknown
  }) => MutationScreening<unknown> | Promise<MutationScreening<unknown>>
  readonly admit: (context: {
    readonly tx: Transaction
    readonly actor: Actor
    readonly args: unknown
  }) => MutationAdmission<unknown> | Promise<MutationAdmission<unknown>>
  readonly execute: (context: {
    readonly tx: Transaction
    readonly actor: Actor
    readonly args: unknown
    readonly evidence: unknown
    readonly stamp: StampAccumulator
    readonly mutationId: string
  }) => AttemptDecision<Refusal> | Promise<AttemptDecision<Refusal>>
  readonly finalizeAccepted?: (context: {
    readonly actor: Actor
    readonly args: unknown
    readonly stamp: AcceptedStamp
    readonly result?: unknown
    readonly screened: unknown
  }) => void | Promise<void>
}

/** The `execute` of a checked mutation's command, as the delivery calls it. */
type CheckedExecute<Transaction, Actor, Preflight, Refusal> = (
  context: Parameters<
    DeliveredCommand<Transaction, Actor, Preflight, Refusal>["execute"]
  >[0] & {
    readonly state: unknown
    readonly effect: unknown
  }
) => AttemptDecision<Refusal> | Promise<AttemptDecision<Refusal>>

/** A checked mutation's `check`, as the delivery calls it. */
type RuntimeCheck<Refusal> = (
  state: unknown,
  args: unknown,
  context: MutationContext
) => Result<unknown, Refusal>

/**
 * The command the delivery runs for one mutation binding. For a mutation
 * defined by `check` and `apply`, `execute` first runs `check` over the state
 * `admit` returned. A refusal is refused and `unchanged()` is accepted with
 * an empty stamp, without the command's `execute`; an effect runs it.
 */
function deliveredMutationCommand<Transaction, Actor, Preflight, Refusal>(
  binding: RuntimeBinding<Actor, Preflight, Transaction, Refusal>
): DeliveredCommand<Transaction, Actor, Preflight, Refusal> {
  const { mutation, command } = binding
  if (!isCheckedMutation(mutation)) return command

  const check = mutation.check as RuntimeCheck<Refusal>
  const execute = command.execute as CheckedExecute<
    Transaction,
    Actor,
    Preflight,
    Refusal
  >

  return {
    ...command,
    execute: (context) => {
      const { state } = context.evidence as { readonly state: unknown }
      const checked = check(state, context.args, {
        mutationId: context.mutationId,
      })
      if (!checked.ok) return refuseMutation(checked.error)
      if (isUnchanged(checked.value)) return acceptMutation({ unchanged: true })

      return execute({ ...context, state, effect: checked.value })
    },
  }
}

/**
 * Delivers one prepared request through its command: derive the actor,
 * check the envelope's scope, screen, execute in the authority, then
 * finalize an acceptance. The one home of the lifecycle order both generated
 * actions document.
 */
async function deliverCommand<Transaction, Actor, Preflight, Refusal>(options: {
  readonly prepared: PreparedMutationRequest
  readonly binder: MutationBinder<Transaction, Actor, Preflight>
  readonly command: DeliveredCommand<Transaction, Actor, Preflight, Refusal>
  readonly parseRefusal: (value: unknown) => Refusal
  readonly parseResult?: (value: unknown) => unknown
  readonly invalidations: InvalidationPublisher | undefined
}): Promise<Result<RecordedTerminalOutcome<Refusal>, MutationExecutorError>> {
  const { prepared, binder, command } = options

  const actor = await binder.actor()

  // An envelope made for another actor, such as one queued before a sign-out,
  // must not run as this one, nor read or claim this actor's receipts.
  if (prepared.scope !== binder.authority.scope(actor)) {
    return ok({ kind: "denied" })
  }

  const screening = await command.screen({
    executor: binder.authority.preflight,
    actor,
    args: structuredClone(prepared.args),
  })
  if (screening.kind === "denied") return ok(screening)

  const outcome = await executePreparedMutation<
    Transaction,
    Actor,
    Refusal,
    Preflight
  >({
    prepared,
    actor,
    authority: binder.authority as MutationAuthorityAdapter<
      Transaction,
      Actor,
      Refusal,
      Preflight
    >,
    parseRefusal: options.parseRefusal,
    parseResult: options.parseResult,
    run: async (tx, stamp, attemptArgs) => {
      const admitted = await command.admit({ tx, actor, args: attemptArgs })
      if (admitted.kind === "denied") return admitted

      return command.execute({
        tx,
        actor,
        args: attemptArgs,
        evidence: admitted.evidence,
        stamp,
        mutationId: prepared.mutationId,
      })
    },
  })
  if (!outcome.ok || outcome.value.kind !== "accepted") return outcome

  const accepted = outcome.value
  try {
    await command.finalizeAccepted?.({
      actor,
      args: structuredClone(prepared.args),
      stamp: accepted.stamp,
      ...("result" in accepted
        ? { result: structuredClone(accepted.result) }
        : {}),
      screened: screening.screened,
    })
  } finally {
    await finalizeStamp(
      accepted.stamp,
      updateTag,
      refresh,
      options.invalidations
    )
  }
  return outcome
}
