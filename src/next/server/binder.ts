import type { StandardSchemaV1 } from "@standard-schema/spec"

import type {
  MutationAttemptFailure,
  MutationAuthorityAdapter,
  StampAccumulator,
} from "../../core/authority"
import {
  findMutation,
  type AnyMutationDefinition,
  type AnyProtocolDefinition,
  type MutationContext,
  type MutationRefusalOf,
  type ProtocolMutation,
} from "../../core/protocol"
import type { AcceptedStamp } from "../../core/revisions"

export type MutationWithRefusal = AnyMutationDefinition & {
  readonly refusal: StandardSchemaV1
}

type MutationArgs<Mutation extends AnyMutationDefinition> = Mutation extends (
  args: infer Args
) => unknown
  ? Args
  : never

/**
 * A command's `screen` result: allowed, carrying the value `finalizeAccepted`
 * receives as `screened`, or denied. Build it with
 * {@link allowMutationScreening} or {@link denyMutation}.
 */
export type MutationScreening<Screened> =
  | { readonly kind: "allowed"; readonly screened: Screened }
  | { readonly kind: "denied" }

/**
 * A command's `admit` result for one transaction attempt: allowed, carrying
 * trusted evidence for `execute`, or denied. Build it with
 * {@link allowMutation} or {@link denyMutation}.
 */
export type MutationAdmission<Evidence> =
  | { readonly kind: "allowed"; readonly evidence: Evidence }
  | { readonly kind: "denied" }

/**
 * The application command's terminal decision inside one authority attempt.
 * A refusal or denial is the attempt failure the authority records as is.
 */
export type MutationCommandDecision<Refusal> =
  | { readonly kind: "accepted" }
  | MutationAttemptFailure<Refusal>

/** Marks transactional admission as allowed and carries its trusted evidence.
 * @param evidence Trusted evidence produced during admission.
 * @returns An allowed admission decision.
 */
export function allowMutation<Evidence>(
  evidence: Evidence
): MutationAdmission<Evidence> {
  return Object.freeze({ kind: "allowed", evidence })
}

/**
 * Marks preflight screening as allowed and carries the value
 * `finalizeAccepted` receives as `screened`.
 * @param screened Value retained for accepted finalization.
 * @returns An allowed screening decision.
 */
export function allowMutationScreening<Screened>(
  screened: Screened
): MutationScreening<Screened> {
  return Object.freeze({ kind: "allowed", screened })
}

/**
 * Denies the mutation from `screen`, `admit`, or `execute`. The generated
 * action returns `ok({ kind: "denied" })` with no reason, unlike a refusal.
 * @returns A denied decision.
 */
export function denyMutation(): { readonly kind: "denied" } {
  return Object.freeze({ kind: "denied" })
}

/** Returns the terminal accepted decision for a command attempt.
 * @returns An accepted command decision.
 */
export function acceptMutation(): { readonly kind: "accepted" } {
  return Object.freeze({ kind: "accepted" })
}

/** Returns a structured refusal that is safe to record and replay.
 * @param error Public refusal value.
 * @returns A refused command decision.
 */
export function refuseMutation<Refusal>(
  error: Refusal
): MutationCommandDecision<Refusal> {
  return Object.freeze({ kind: "refused", error })
}

/** One app-owned command bound to a client-safe mutation definition. */
export interface MutationCommand<
  Mutation extends MutationWithRefusal,
  Actor,
  Preflight,
  Transaction,
  Screened,
  Evidence,
> {
  /**
   * Runs once per delivery, outside any transaction and before the authority
   * claims a receipt. Return {@link allowMutationScreening} or
   * {@link denyMutation}; a denial claims no receipt.
   */
  readonly screen: (context: {
    /** The authority's preflight executor, which reads committed state only. */
    readonly executor: Preflight
    readonly actor: Actor
    readonly args: MutationArgs<Mutation>
  }) => MutationScreening<Screened> | Promise<MutationScreening<Screened>>
  /**
   * Runs at the start of each transaction attempt, so it runs again after
   * contention; read and write only through `tx`. Return
   * {@link allowMutation} or {@link denyMutation}; a denial is recorded and
   * replays on redelivery.
   */
  readonly admit: (context: {
    readonly tx: Transaction
    readonly actor: Actor
    readonly args: MutationArgs<Mutation>
  }) => MutationAdmission<Evidence> | Promise<MutationAdmission<Evidence>>
  /**
   * Runs after `admit` in the same attempt. Write domain rows through `tx`,
   * record each axis the attempt advances on `stamp`, and return
   * {@link acceptMutation}, {@link refuseMutation}, or {@link denyMutation}.
   */
  readonly execute: (
    context: {
      readonly tx: Transaction
      readonly actor: Actor
      readonly args: MutationArgs<Mutation>
      /** The evidence `admit` returned in this attempt. */
      readonly evidence: Evidence
      /** Records each axis revision this attempt advances. */
      readonly stamp: StampAccumulator
    } & MutationContext
  ) =>
    | MutationCommandDecision<MutationRefusalOf<Mutation>>
    | Promise<MutationCommandDecision<MutationRefusalOf<Mutation>>>
  /**
   * Runs after every accepted delivery, including recovery from a stored
   * receipt, and before the action expires cache tags, refreshes, or
   * publishes invalidations. Implementations must be repeat-safe.
   */
  readonly finalizeAccepted?: (context: {
    readonly actor: Actor
    readonly args: MutationArgs<Mutation>
    readonly stamp: AcceptedStamp
    /** The value `screen` returned for this delivery. */
    readonly screened: Screened
  }) => void | Promise<void>
}

declare const BINDER: unique symbol

/**
 * The identity of the binder that made a binding. It is a type-level brand
 * with no runtime key; the action compares binder objects by reference.
 */
export interface MutationBinderIdentity {
  readonly [BINDER]: true
}

/** Definition-keyed association between one mutation and its application command. */
export interface MutationBinding<
  Mutation extends MutationWithRefusal,
  Command = unknown,
> {
  /** The protocol's definition object for this mutation. */
  readonly mutation: Mutation
  /** The application command that runs this mutation. */
  readonly command: Command
  /** The binder that made this binding; only its action accepts the binding. */
  readonly binder: MutationBinderIdentity
}

/**
 * The trusted actor and the authority that one set of commands runs with,
 * and the `bind` that types those commands. Create it once per authority, at
 * module level, and give the same binder to `createNextMutationAction`.
 */
export interface MutationBinder<
  Transaction,
  Actor,
  Preflight,
> extends MutationBinderIdentity {
  /** Derives the trusted actor. It never rides the wire. */
  readonly actor: () => Actor | Promise<Actor>
  /** The authority every command bound here runs inside. */
  readonly authority: MutationAuthorityAdapter<
    Transaction,
    Actor,
    unknown,
    Preflight
  >
  /**
   * Binds by definition identity, preserving the mutation's exact argument
   * type. The command's `actor`, `executor`, and `tx` are this binder's, so a
   * command needs no type annotation. Write its members in lifecycle order
   * (`screen`, `admit`, `execute`, `finalizeAccepted`) so `evidence` and
   * `screened` are inferred.
   */
  readonly bind: <
    const Mutation extends MutationWithRefusal,
    Screened,
    Evidence,
  >(
    mutation: Mutation,
    command: MutationCommand<
      NoInfer<Mutation>,
      Actor,
      Preflight,
      Transaction,
      Screened,
      Evidence
    >
    // NoInfer: inside `commands`, the action's contextual type would otherwise
    // infer `Mutation` from this return type, and the command's return
    // expressions would see that wide `Mutation`, so a literal refusal widens.
  ) => NoInfer<
    MutationBinding<
      Mutation,
      MutationCommand<
        Mutation,
        Actor,
        Preflight,
        Transaction,
        Screened,
        Evidence
      >
    >
  >
}

/**
 * Every actor the callback can return must be an actor the authority accepts.
 * This is checked explicitly and as a whole, because the adapter's `execute`
 * is a method, so plain assignability would compare its actor bivariantly.
 */
type AcceptsActor<Actor, AuthorityActor> = [Actor] extends [AuthorityActor]
  ? unknown
  : { readonly __authorityDoesNotAcceptActor: never }

/**
 * Creates the binder for one trusted actor callback and one authority. The
 * actor type is the callback's; the compiler rejects an authority that
 * cannot accept every actor the callback returns. Create it once, next to
 * the authority, in a module that does not import the command modules.
 * @param context The trusted actor callback and the authority it runs with.
 * @returns A frozen binder whose `bind` types commands with this context.
 */
export function createMutationBinder<
  Transaction,
  Actor,
  Preflight,
  AuthorityActor,
>(context: {
  readonly actor: () => Actor | Promise<Actor>
  readonly authority: MutationAuthorityAdapter<
    Transaction,
    AuthorityActor,
    unknown,
    Preflight
  > &
    AcceptsActor<Actor, AuthorityActor>
}): MutationBinder<Transaction, Actor, Preflight> {
  type Binder = MutationBinder<Transaction, Actor, Preflight>
  const bind: Binder["bind"] = (mutation, command) =>
    Object.freeze({ mutation, command, binder })
  // The brand has no runtime key, so the object is asserted to carry it.
  const binder = Object.freeze({
    actor: context.actor,
    // AcceptsActor proved that every Actor is an AuthorityActor.
    authority: context.authority as Binder["authority"],
    bind,
  }) as Binder
  return binder
}

export type AnyMutationBinding = MutationBinding<MutationWithRefusal>

export type BoundMutation<Commands extends readonly AnyMutationBinding[]> =
  Commands[number] extends MutationBinding<infer Mutation, unknown>
    ? Mutation
    : never

type CompleteBindings<
  Protocol,
  Commands extends readonly AnyMutationBinding[],
> =
  Exclude<ProtocolMutation<Protocol>, BoundMutation<Commands>> extends never
    ? Exclude<BoundMutation<Commands>, ProtocolMutation<Protocol>> extends never
      ? unknown
      : { readonly __unknownMutationBinding: never }
    : { readonly __missingMutationBinding: never }

/** `true` when `T` is a union of more than one member. */
type IsUnion<T, U = T> = T extends unknown
  ? [U] extends [T]
    ? false
    : true
  : never

/** `true` when `Name` is exactly one string literal. */
type OneLiteralName<Name> = [Name] extends [string]
  ? string extends Name
    ? false
    : IsUnion<Name> extends true
      ? false
      : true
  : false

/**
 * Walks a fixed list once, front to back: each entry must be one binding
 * (not a union), name one mutation not seen before, and carry a command that
 * accepts the action's context. Every check wraps its operands in `[]`, so a
 * union is checked as a whole instead of branch by branch.
 */
type EachBinding<
  Commands,
  Actor,
  Preflight,
  Transaction,
  Seen extends string = never,
> = [Commands] extends [readonly []]
  ? unknown
  : [Commands] extends [readonly [infer First, ...infer Rest]]
    ? IsUnion<First> extends true
      ? { readonly __ambiguousMutationBinding: never }
      : [First] extends [MutationBinding<infer Mutation, infer Command>]
        ? OneLiteralName<Mutation["name"]> extends true
          ? Mutation["name"] extends Seen
            ? { readonly __duplicateMutationBinding: Mutation["name"] }
            : [Command] extends [
                  MutationCommand<
                    Mutation,
                    Actor,
                    Preflight,
                    Transaction,
                    infer _Screened,
                    infer _Evidence
                  >,
                ]
              ? EachBinding<
                  Rest,
                  Actor,
                  Preflight,
                  Transaction,
                  Seen | (Mutation["name"] & string)
                >
              : { readonly __incompatibleMutationCommand: Mutation["name"] }
          : { readonly __ambiguousMutationBinding: never }
        : { readonly __incompatibleMutationCommand: never }
    : { readonly __commandsMustBeFixedList: never }

/**
 * Compile-time form of `assertValidBindings`: one fixed list that binds
 * every protocol mutation exactly once, each to a command that accepts the
 * action's context. A union of lists is rejected, not split.
 */
export type ValidBindings<
  Protocol,
  Commands extends readonly AnyMutationBinding[],
  Actor,
  Preflight,
  Transaction,
> =
  IsUnion<Commands> extends true
    ? { readonly __commandsMustBeOneFixedList: never }
    : CompleteBindings<Protocol, Commands> &
        EachBinding<Commands, Actor, Preflight, Transaction>

export function assertValidBindings(
  protocol: AnyProtocolDefinition,
  binder: MutationBinderIdentity,
  commands: readonly AnyMutationBinding[]
): void {
  const expected = new Set(protocol.mutations.map(({ name }) => name))
  const registered = new Set<string>()

  for (const { mutation, binder: madeBy } of commands) {
    if (registered.has(mutation.name)) {
      throw new Error(`Duplicate mutation binding: ${mutation.name}`)
    }
    if (findMutation(protocol, mutation.name) !== mutation) {
      throw new Error(
        `Mutation binding does not use the protocol definition: ${mutation.name}`
      )
    }
    if (madeBy !== binder) {
      throw new Error(
        `Mutation binding was made by another binder: ${mutation.name}`
      )
    }
    registered.add(mutation.name)
  }

  const missing = [...expected].filter((name) => !registered.has(name))
  const unexpected = [...registered].filter((name) => !expected.has(name))
  if (missing.length === 0 && unexpected.length === 0) return

  throw new Error(
    `Incomplete mutation bindings: missing [${missing.join(", ")}], unknown [${unexpected.join(", ")}]`
  )
}
