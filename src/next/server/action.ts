import type { StandardSchemaV1 } from "@standard-schema/spec"
import { refresh, updateTag } from "next/cache"
import { err, ok, type Result } from "serializable-result"

import {
  executePreparedMutation,
  prepareMutationRequest,
  type MutationAuthorityAdapter,
  type MutationExecutorError,
  type MutationTerminalOutcome,
  type ProtocolIdentity,
} from "../../core/authority"
import type { InvalidationPublisher } from "../../core/invalidation"
import type {
  AnyProtocolDefinition,
  MutationRefusalOf,
} from "../../core/protocol"
import {
  assertValidBindings,
  type AnyMutationBinding,
  type BoundMutation,
  type MutationBinder,
  type MutationBinding,
  type MutationCommand,
  type MutationWithRefusal,
  type ValidBindings,
} from "../../server/binder"
import { parseMutationRefusal } from "../../server/refusal"
import { finalizeStamp } from "./revalidation"

/**
 * The erased form the action dispatches through once the binding list has
 * been checked: any parsed args and the protocol's refusal union.
 */
type RuntimeMutation<Refusal> = MutationWithRefusal &
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
 * command runs. It runs `screen` before it claims a receipt, and runs `admit`
 * and `execute` inside the authority's transaction attempts, which may repeat.
 * When no receipt exists and the envelope's `createdAt` is outside the
 * authority's delivery window, it returns `delivery-expired` or
 * `delivery-from-future` after `screen`, without admitting or recording it.
 * `screen` and `finalizeAccepted` each receive their own copy of the parsed
 * arguments; `admit` and `execute` share one fresh copy per attempt. The
 * authority owns receipt deduplication and contention; commands own
 * application authorization, domain writes, axis stamping, and the
 * repeat-safe `finalizeAccepted` projection.
 *
 * A denial, from screening or from a recorded transaction-time admission,
 * returns `ok({ kind: "denied" })`. It carries no reason, so it reveals no
 * more than an HTTP 403, and it needs no Next configuration. A screening denial
 * claims no receipt; a recorded denial replays on redelivery.
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
    const actor = await binder.actor()
    const screening = await binding.command.screen({
      executor: binder.authority.preflight,
      actor,
      args: structuredClone(prepared.value.args),
    })
    if (screening.kind === "denied") return ok(screening)

    const outcome = await executePreparedMutation<
      Transaction,
      Actor,
      Refusal,
      Preflight
    >({
      prepared: prepared.value,
      actor,
      authority: binder.authority as MutationAuthorityAdapter<
        Transaction,
        Actor,
        Refusal,
        Preflight
      >,
      parseRefusal: (value) =>
        parseMutationRefusal<Refusal>(binding.mutation.refusal, value),
      run: async (tx, stamp, attemptArgs) => {
        const admitted = await binding.command.admit({
          tx,
          actor,
          args: attemptArgs,
        })
        if (admitted.kind === "denied") return err(admitted)

        const decision = await binding.command.execute({
          tx,
          actor,
          args: attemptArgs,
          evidence: admitted.evidence,
          stamp,
          mutationId: prepared.value.mutationId,
        })
        return decision.kind === "accepted" ? ok(undefined) : err(decision)
      },
    })
    if (!outcome.ok || outcome.value.kind !== "accepted") return outcome

    const { stamp } = outcome.value
    try {
      await binding.command.finalizeAccepted?.({
        actor,
        args: structuredClone(prepared.value.args),
        stamp,
        screened: screening.screened,
      })
    } finally {
      await finalizeStamp(stamp, updateTag, refresh, options.invalidations)
    }
    return outcome
  }
}
