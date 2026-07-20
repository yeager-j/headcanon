import type { StandardSchemaV1 } from "@standard-schema/spec"

import type { Result } from "@workspace/result"

/** Serializable intent produced by a named mutation's invocation factory. */
export interface MutationInvocation<Name extends string, Args> {
  readonly name: Name
  readonly args: Args
}

/**
 * A mutation's shared protocol definition and callable invocation factory.
 *
 * The schema is parsed again at the authority. `predict` must be pure and
 * deterministic because later canons replay the same invocation through it.
 */
export interface MutationDefinition<
  Name extends string,
  Schema extends StandardSchemaV1,
  State,
  PredictionError,
> {
  (
    args: StandardSchemaV1.InferOutput<Schema>
  ): MutationInvocation<Name, StandardSchemaV1.InferOutput<Schema>>
  readonly name: Name
  readonly args: Schema
  readonly predict: (
    state: State,
    args: StandardSchemaV1.InferOutput<Schema>
  ) => Result<State, PredictionError>
}

export interface AnyMutationDefinition {
  (...args: never[]): unknown
  readonly name: string
  readonly args: StandardSchemaV1
  readonly predict: (...args: never[]) => Result<unknown, unknown>
}

type MutationState<Mutation extends AnyMutationDefinition> = Parameters<
  Mutation["predict"]
>[0]

type MutationForState<State> = AnyMutationDefinition & {
  readonly predict: (state: State, ...args: never[]) => Result<State, unknown>
}

type OneStateMutations<Mutations extends readonly AnyMutationDefinition[]> =
  Mutations extends readonly [
    infer First extends AnyMutationDefinition,
    ...infer Rest extends readonly AnyMutationDefinition[],
  ]
    ? Rest[number] extends MutationForState<MutationState<First>>
      ? unknown
      : never
    : unknown

/** Extracts the serializable invocation produced by a mutation definition. */
export type InvocationOf<Mutation> = Mutation extends (
  args: never
) => infer Invocation
  ? Invocation
  : never

type MutationName<Mutation> = Mutation extends { readonly name: infer Name }
  ? Name & string
  : never

export type MutationRegistry<
  Mutations extends readonly AnyMutationDefinition[],
> = {
  readonly [Name in MutationName<Mutations[number]>]: Extract<
    Mutations[number],
    { readonly name: Name }
  >
}

/** A stable protocol ID and its immutable, uniquely named mutation registry. */
export interface ProtocolDefinition<
  Id extends string,
  Mutations extends readonly AnyMutationDefinition[],
> {
  readonly id: Id
  readonly mutations: Mutations
  readonly mutationsByName: MutationRegistry<Mutations>
}

/** The union of every invocation admitted by a protocol definition. */
export type ProtocolInvocation<Protocol> =
  Protocol extends ProtocolDefinition<string, infer Mutations>
    ? InvocationOf<Mutations[number]>
    : never

/**
 * Defines one named mutation and returns its typed invocation factory.
 *
 * Calling the result packages already-typed arguments without treating local
 * construction as authority validation; the registered schema owns parsing at
 * the trust boundary.
 */
export function defineMutation<
  const Name extends string,
  Schema extends StandardSchemaV1,
  State,
  PredictionError,
>(definition: {
  readonly name: Name
  readonly args: Schema
  readonly predict: (
    state: State,
    args: StandardSchemaV1.InferOutput<Schema>
  ) => Result<State, PredictionError>
}): MutationDefinition<Name, Schema, State, PredictionError> {
  const invoke = (args: StandardSchemaV1.InferOutput<Schema>) =>
    Object.freeze({ name: definition.name, args })

  Object.defineProperties(invoke, {
    name: { value: definition.name, enumerable: true },
    args: { value: definition.args, enumerable: true },
    predict: { value: definition.predict, enumerable: true },
  })

  return Object.freeze(invoke) as MutationDefinition<
    Name,
    Schema,
    State,
    PredictionError
  >
}

/**
 * Registers a closed set of mutations under one stable protocol ID.
 *
 * Duplicate mutation names throw during definition so wire dispatch can make
 * the name-to-definition distinction exactly once.
 */
export function defineProtocol<
  const Id extends string,
  const Mutations extends readonly AnyMutationDefinition[],
>(definition: {
  readonly id: Id
  readonly mutations: Mutations & OneStateMutations<Mutations>
}): ProtocolDefinition<Id, Mutations> {
  const mutations = Object.freeze([
    ...definition.mutations,
  ]) as unknown as Mutations
  const mutationsByName = Object.create(null) as Record<
    string,
    AnyMutationDefinition
  >

  for (const mutation of mutations) {
    if (mutation.args === undefined || typeof mutation.predict !== "function") {
      throw new Error(`Invalid mutation definition: ${mutation.name}`)
    }
    if (Object.hasOwn(mutationsByName, mutation.name)) {
      throw new Error(`Duplicate mutation name: ${mutation.name}`)
    }
    mutationsByName[mutation.name] = mutation
  }

  return Object.freeze({
    id: definition.id,
    mutations,
    mutationsByName: Object.freeze(
      mutationsByName
    ) as MutationRegistry<Mutations>,
  })
}
