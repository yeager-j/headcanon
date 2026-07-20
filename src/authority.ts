import type { StandardSchemaV1 } from "@standard-schema/spec"

import { err, ok, type Result } from "@workspace/result"

import {
  prepareCanonicalInvocation,
  type CanonicalInvocation,
  type CanonicalInvocationError,
} from "./canonical-invocation"
import type {
  AnyMutationDefinition,
  MutationInvocation,
  ProtocolDefinition,
} from "./protocol"
import type { AcceptedStamp, AxisId, Revision } from "./revisions"

/** The transport envelope admitted by a mutation authority executor. */
export interface MutationEnvelope<Invocation> {
  readonly protocol: string
  readonly mutationId: string
  readonly invocation: Invocation
}

/** The attempt-local authority for constructing a complete accepted vector. */
export interface StampAccumulator {
  record(axis: AxisId, revision: Revision): void
}

/** Context supplied to one rerunnable authority handler attempt. */
export interface MutationHandlerContext<Transaction, Args, Actor> {
  readonly tx: Transaction
  readonly args: Args
  readonly actor: Actor
  readonly stamp: StampAccumulator
}

export type MutationHandler<Transaction, Args, Actor, Rejection> = (
  context: MutationHandlerContext<Transaction, Args, Actor>
) => Result<void, Rejection> | Promise<Result<void, Rejection>>

type MutationsOf<Protocol> =
  Protocol extends ProtocolDefinition<string, infer Mutations>
    ? Mutations[number]
    : never

type MutationName<Mutation> = Mutation extends { readonly name: infer Name }
  ? Name & string
  : never

type MutationArgs<Mutation> = Mutation extends {
  readonly args: infer Schema extends StandardSchemaV1
}
  ? StandardSchemaV1.InferOutput<Schema>
  : never

/** Exhaustive handler registration for one protocol's closed mutation set. */
export type MutationHandlers<
  Protocol extends ProtocolDefinition<string, readonly AnyMutationDefinition[]>,
  Transaction,
  Actor,
  Rejection,
> = {
  readonly [Name in MutationName<MutationsOf<Protocol>>]: MutationHandler<
    Transaction,
    MutationArgs<Extract<MutationsOf<Protocol>, { readonly name: Name }>>,
    Actor,
    Rejection
  >
}

/** A terminal outcome which is safe to record and reproduce on redelivery. */
export type MutationTerminalOutcome<Rejection> =
  | { readonly kind: "accepted"; readonly stamp: AcceptedStamp }
  | { readonly kind: "rejected"; readonly error: Rejection }

export type MutationAuthorityAdapterError =
  | { readonly code: "mutation-id-reused"; readonly mutationId: string }
  | { readonly code: "contention"; readonly mutationId: string }

export interface MutationAuthorityRequest<Actor> {
  readonly actor: Actor
  readonly mutationId: string
  readonly canonical: CanonicalInvocation
}

/**
 * Owns receipt identity, transaction attempts, savepoint behavior, and retry.
 *
 * The callback may run more than once. An adapter must discard both its
 * transactional effects and its stamp accumulator whenever an attempt rolls
 * back.
 */
export interface MutationAuthorityAdapter<Transaction, Actor, Rejection> {
  execute(
    request: MutationAuthorityRequest<Actor>,
    run: (
      tx: Transaction,
      stamp: StampAccumulator
    ) => Promise<Result<void, Rejection>>
  ): Promise<
    Result<MutationTerminalOutcome<Rejection>, MutationAuthorityAdapterError>
  >
}

export type MutationExecutorError =
  | {
      readonly code: "invalid-envelope"
      readonly reason:
        | "not-plain-object"
        | "unexpected-fields"
        | "invalid-protocol"
        | "invalid-mutation-id"
        | "invalid-invocation"
        | "unknown-mutation"
    }
  | {
      readonly code: "invalid-arguments"
      readonly mutation: string
      readonly issues: readonly StandardSchemaV1.Issue[]
    }
  | {
      readonly code: "canonical-invocation"
      readonly error: CanonicalInvocationError
    }
  | MutationAuthorityAdapterError

interface ParsedEnvelope {
  readonly protocol: string
  readonly mutationId: string
  readonly invocation: MutationInvocation<string, unknown>
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false
  }

  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false

  return Reflect.ownKeys(value).every((key) => {
    if (typeof key === "symbol") return false
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor?.enumerable === true && "value" in descriptor
  })
}

function hasExactly(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  )
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function parseEnvelope(
  value: unknown,
  protocolId: string,
  mutationNames: ReadonlySet<string>
): Result<ParsedEnvelope, MutationExecutorError> {
  if (!isPlainRecord(value)) {
    return err({ code: "invalid-envelope", reason: "not-plain-object" })
  }
  if (!hasExactly(value, ["protocol", "mutationId", "invocation"])) {
    return err({ code: "invalid-envelope", reason: "unexpected-fields" })
  }
  if (value.protocol !== protocolId) {
    return err({ code: "invalid-envelope", reason: "invalid-protocol" })
  }
  if (
    typeof value.mutationId !== "string" ||
    !UUID_PATTERN.test(value.mutationId)
  ) {
    return err({ code: "invalid-envelope", reason: "invalid-mutation-id" })
  }
  if (!isPlainRecord(value.invocation)) {
    return err({ code: "invalid-envelope", reason: "invalid-invocation" })
  }
  if (!hasExactly(value.invocation, ["name", "args"])) {
    return err({ code: "invalid-envelope", reason: "unexpected-fields" })
  }
  if (
    typeof value.invocation.name !== "string" ||
    !mutationNames.has(value.invocation.name)
  ) {
    return err({ code: "invalid-envelope", reason: "unknown-mutation" })
  }

  return ok({
    protocol: protocolId,
    mutationId: value.mutationId,
    invocation: {
      name: value.invocation.name,
      args: value.invocation.args,
    },
  })
}

function assertCompleteHandlers(
  mutationNames: ReadonlySet<string>,
  handlers: Readonly<Record<string, unknown>>
): void {
  const registered = Object.keys(handlers)
  const missing = [...mutationNames].filter(
    (name) => !Object.hasOwn(handlers, name)
  )
  const unknown = registered.filter((name) => !mutationNames.has(name))

  if (missing.length === 0 && unknown.length === 0) return

  throw new Error(
    `Incomplete mutation handlers: missing [${missing.join(", ")}], unknown [${unknown.join(", ")}]`
  )
}

/**
 * Creates the framework-independent authority door for one protocol.
 *
 * It strictly parses the envelope, reparses mutation arguments, computes the
 * canonical receipt identity, and dispatches through the adapter-owned
 * transactional attempt.
 */
export function createMutationExecutor<
  const Protocol extends ProtocolDefinition<
    string,
    readonly AnyMutationDefinition[]
  >,
  Transaction,
  Actor,
  Rejection,
>(options: {
  readonly protocol: Protocol
  readonly authority: MutationAuthorityAdapter<Transaction, Actor, Rejection>
  readonly handlers: MutationHandlers<Protocol, Transaction, Actor, Rejection>
}) {
  const mutationNames = new Set(
    options.protocol.mutations.map((mutation) => mutation.name)
  )
  assertCompleteHandlers(
    mutationNames,
    options.handlers as Readonly<Record<string, unknown>>
  )

  return async (
    envelope: unknown,
    actor: Actor
  ): Promise<
    Result<MutationTerminalOutcome<Rejection>, MutationExecutorError>
  > => {
    const parsedEnvelope = parseEnvelope(
      envelope,
      options.protocol.id,
      mutationNames
    )
    if (!parsedEnvelope.ok) return parsedEnvelope

    const definition =
      options.protocol.mutationsByName[parsedEnvelope.value.invocation.name]
    if (!definition) {
      return err({ code: "invalid-envelope", reason: "unknown-mutation" })
    }

    const parsedArguments = await definition.args["~standard"].validate(
      parsedEnvelope.value.invocation.args
    )
    if (parsedArguments.issues) {
      return err({
        code: "invalid-arguments",
        mutation: definition.name,
        issues: parsedArguments.issues,
      })
    }

    const invocation = {
      name: definition.name,
      args: parsedArguments.value,
    }
    const prepared = await prepareCanonicalInvocation(
      options.protocol.id,
      invocation
    )
    if (!prepared.ok) {
      return err({ code: "canonical-invocation", error: prepared.error })
    }

    const handler = (
      options.handlers as Readonly<
        Record<string, MutationHandler<Transaction, unknown, Actor, Rejection>>
      >
    )[definition.name]
    if (!handler)
      throw new Error(`Missing mutation handler: ${definition.name}`)

    return options.authority.execute(
      {
        actor,
        mutationId: parsedEnvelope.value.mutationId,
        canonical: prepared.value.canonical,
      },
      (tx, stamp) =>
        Promise.resolve(
          handler({
            tx,
            args: structuredClone(prepared.value.invocation.args),
            actor,
            stamp,
          })
        )
    )
  }
}
