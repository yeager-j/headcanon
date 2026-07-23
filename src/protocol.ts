import type { StandardSchemaV1 } from "@standard-schema/spec"

import type { Result } from "@workspace/result"

/** Serializable intent produced by a named mutation's invocation factory. */
export interface MutationInvocation<Name extends string, Args, Error = never> {
  readonly name: Name
  readonly args: Args
  /** Type-only carrier for the invocation's correlated public error. */
  readonly __error?: Error
}

type RefusalOfSchema<Schema> = Schema extends StandardSchemaV1
  ? StandardSchemaV1.InferOutput<Schema>
  : never

/** Package-owned identity shared by prediction replay and authority execution. */
export interface MutationContext {
  readonly mutationId: string
}

/**
 * A mutation's shared protocol definition and callable invocation factory.
 *
 * The schema is parsed again at the authority. `predict` must be pure and
 * deterministic because later canons replay the same invocation through it.
 * @param args Parsed arguments accepted by the invocation factory.
 * @returns A serializable named mutation invocation.
 */
export type MutationDefinition<
  Name extends string,
  Schema extends StandardSchemaV1,
  State,
  PredictionError,
  RefusalSchema extends StandardSchemaV1 | undefined = undefined,
> = {
  (
    args: StandardSchemaV1.InferOutput<Schema>
  ): MutationInvocation<
    Name,
    StandardSchemaV1.InferOutput<Schema>,
    PredictionError | RefusalOfSchema<RefusalSchema>
  >
  readonly name: Name
  readonly args: Schema
  readonly predict: (
    state: State,
    args: StandardSchemaV1.InferOutput<Schema>,
    context: MutationContext
  ) => Result<State, PredictionError>
} & (RefusalSchema extends StandardSchemaV1
  ? { readonly refusal: RefusalSchema }
  : { readonly refusal?: undefined })

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

/** Extracts the public authority refusal admitted by a mutation's codec. */
export type MutationRefusalOf<Mutation> = Mutation extends {
  readonly refusal: infer Schema extends StandardSchemaV1
}
  ? StandardSchemaV1.InferOutput<Schema>
  : never

/** Extracts the predictor plus authority refusal correlated to a mutation. */
export type MutationErrorOf<Mutation> =
  InvocationOf<Mutation> extends MutationInvocation<
    string,
    unknown,
    infer Error
  >
    ? Error
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
 * Defines one mutation's shared client/server contract and returns its typed
 * invocation factory.
 *
 * The returned function is the value callers use to express intent. It adds the
 * stable mutation name and preserves the typed arguments for prediction,
 * transport, and authority dispatch. Calling it does not authorize, persist,
 * or re-parse the arguments; the server parses them again at the trust
 * boundary. `predict` must be pure and deterministic because pending
 * invocations are replayed over later authoritative canons. If `refusal` is
 * supplied, its output schema defines the structured error that may be stored
 * and reproduced from a receipt.
 *
 * @param definition Stable name, argument schema, pure predictor, and optional refusal schema.
 * @returns A frozen callable mutation definition with stable wire metadata.
 * @throws An error from the schema/predictor setup only if the supplied definition is invalid at runtime.
 */
export function defineMutation<
  const Name extends string,
  Schema extends StandardSchemaV1,
  State,
  PredictionError,
  RefusalSchema extends StandardSchemaV1 | undefined = undefined,
>(definition: {
  readonly name: Name
  readonly args: Schema
  /** Runtime codec for authority refusals which may cross the receipt boundary. */
  readonly refusal?: RefusalSchema
  readonly predict: (
    state: State,
    args: StandardSchemaV1.InferOutput<Schema>,
    context: MutationContext
  ) => Result<State, PredictionError>
}): MutationDefinition<Name, Schema, State, PredictionError, RefusalSchema> {
  const invoke = (args: StandardSchemaV1.InferOutput<Schema>) =>
    Object.freeze({ name: definition.name, args })

  Object.defineProperties(invoke, {
    name: { value: definition.name, enumerable: true },
    args: { value: definition.args, enumerable: true },
    ...(definition.refusal === undefined
      ? {}
      : { refusal: { value: definition.refusal, enumerable: true } }),
    predict: { value: definition.predict, enumerable: true },
  })

  return Object.freeze(invoke) as MutationDefinition<
    Name,
    Schema,
    State,
    PredictionError,
    RefusalSchema
  >
}

/**
 * Registers a closed set of mutations under one stable protocol ID.
 *
 * A protocol is the dispatch boundary shared by the browser and authority. It
 * freezes the mutation list and builds a name-indexed registry so the server
 * can resolve an untrusted invocation name exactly once before running the
 * matching command. TypeScript also requires all mutations in the registry to
 * predict the same state shape. Duplicate names and malformed definitions
 * throw during construction; they are programmer/configuration errors, not
 * request-level refusals.
 *
 * @param definition Stable protocol ID and closed mutation registry.
 * @returns A frozen protocol definition with name-indexed mutation lookup.
 * @throws Error when a mutation is malformed or two mutations share a name.
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
