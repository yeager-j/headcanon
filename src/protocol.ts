import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { Result } from "serializable-result"

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

/**
 * Rejects an argument schema whose parsed output is not itself a valid input.
 *
 * The invocation factory takes parsed (output) arguments, the predictor runs
 * on them, and authority parses them again as wire input. That is only one
 * value on both sides when parsing an already-parsed value returns it
 * unchanged, so the types require output to be valid input and authority
 * rejects arguments its schema changes.
 */
type ParsedFormSchema<Schema extends StandardSchemaV1> =
  StandardSchemaV1.InferOutput<Schema> extends StandardSchemaV1.InferInput<Schema>
    ? unknown
    : {
        readonly "~headcanon": "A mutation argument schema's output must be a valid input"
      }

/** Package-owned identity shared by prediction replay and authority execution. */
export interface MutationContext {
  readonly mutationId: string
}

/**
 * A mutation's shared protocol definition and callable invocation factory.
 *
 * Arguments are always in parsed form: the factory takes the schema's output,
 * the predictor and the server command receive that same value, and authority
 * parses it again and refuses it unless parsing leaves it unchanged. `predict`
 * must be pure and deterministic because later canons replay the same
 * invocation through it.
 * @param args Arguments in the schema's parsed (output) form.
 * @returns A frozen, serializable named mutation invocation.
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

/**
 * The erased shape every {@link MutationDefinition} satisfies, used as a
 * registry bound.
 * @param args Arguments of the erased invocation factory.
 * @returns The erased invocation.
 */
export interface AnyMutationDefinition {
  (...args: never[]): unknown
  readonly name: string
  readonly args: StandardSchemaV1
  readonly predict: (...args: never[]) => Result<unknown, unknown>
}

type MutationState<Mutation> = Mutation extends AnyMutationDefinition
  ? Parameters<Mutation["predict"]>[0]
  : never

type MutationForState<State> = AnyMutationDefinition & {
  readonly predict: (state: State, ...args: never[]) => Result<State, unknown>
}

/**
 * Requires every mutation in a registry to predict one state type: each
 * predictor must accept and return the union of all predictors' states. It
 * reads only the element union, so tuples and ordinary arrays get the same
 * check.
 */
type OneStateMutations<Mutations extends readonly AnyMutationDefinition[]> = [
  Mutations[number],
] extends [MutationForState<MutationState<Mutations[number]>>]
  ? unknown
  : never

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

/** A stable protocol ID and its immutable, uniquely named mutation list. */
export interface ProtocolDefinition<
  Id extends string,
  Mutations extends readonly AnyMutationDefinition[],
> {
  readonly id: Id
  readonly mutations: Mutations
}

/** The union of every invocation admitted by a protocol definition. */
export type ProtocolInvocation<Protocol> =
  Protocol extends ProtocolDefinition<string, infer Mutations>
    ? InvocationOf<Mutations[number]>
    : never

/**
 * Finds a protocol's mutation by its stable wire name. Names are unique by
 * construction, and the comparison is exact, so an untrusted name such as
 * `__proto__` or `toString` finds nothing.
 * @param protocol Protocol whose mutation list to search.
 * @param name Untrusted or trusted mutation name.
 * @returns The mutation definition with that name, or `undefined`.
 */
export function findMutation<Mutation extends AnyMutationDefinition>(
  protocol: ProtocolDefinition<string, readonly Mutation[]>,
  name: unknown
): Mutation | undefined {
  return protocol.mutations.find((mutation) => mutation.name === name)
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze((value as Record<PropertyKey, unknown>)[key])
    }
  }
  return value
}

/**
 * Defines one mutation's shared client/server contract and returns its typed
 * invocation factory.
 *
 * The returned function is the value callers use to express intent. It adds the
 * stable mutation name and keeps a deeply frozen copy of the arguments for
 * prediction, transport, and authority dispatch. Calling it does not
 * authorize, persist, or parse the arguments. Arguments are in the schema's
 * parsed (output) form; the server parses them again at the trust boundary
 * and refuses them unless parsing leaves them unchanged, so the predictor and
 * the server command always see the same value. A schema whose output is not
 * a valid input is a compile error. `predict` must be pure and deterministic
 * because pending invocations are replayed over later authoritative canons.
 * If `refusal` is supplied, its output schema defines the structured error
 * that may be stored and reproduced from a receipt. The definition is read
 * once: later changes to the passed object do not affect the factory.
 *
 * @param definition Stable name, argument schema, pure predictor, and optional refusal schema.
 * @returns A frozen callable mutation definition with stable wire metadata.
 * @throws An error from `structuredClone` when called with arguments that are not plain data.
 */
export function defineMutation<
  const Name extends string,
  Schema extends StandardSchemaV1,
  State,
  PredictionError,
  RefusalSchema extends StandardSchemaV1 | undefined = undefined,
>(definition: {
  readonly name: Name
  readonly args: Schema & ParsedFormSchema<Schema>
  /** Runtime codec for authority refusals which may cross the receipt boundary. */
  readonly refusal?: RefusalSchema
  readonly predict: (
    state: State,
    args: StandardSchemaV1.InferOutput<Schema>,
    context: MutationContext
  ) => Result<State, PredictionError>
}): MutationDefinition<Name, Schema, State, PredictionError, RefusalSchema> {
  const { name, args: schema, refusal, predict } = definition
  const invoke = (args: StandardSchemaV1.InferOutput<Schema>) =>
    Object.freeze({ name, args: deepFreeze(structuredClone(args)) })

  Object.defineProperties(invoke, {
    name: { value: name, enumerable: true },
    args: { value: schema, enumerable: true },
    ...(refusal === undefined
      ? {}
      : { refusal: { value: refusal, enumerable: true } }),
    predict: { value: predict, enumerable: true },
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
 * freezes the mutation list, which is the one registry: authority and the
 * predicted root resolve a name through it exactly once. TypeScript also
 * requires all mutations in the registry to predict the same state shape,
 * whether they are passed as an inline tuple or a predeclared array.
 * Duplicate names and malformed definitions throw during construction; they
 * are programmer/configuration errors, not request-level refusals.
 *
 * @param definition Stable protocol ID and closed mutation registry.
 * @returns A frozen protocol definition.
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
  const names = new Set<string>()

  for (const mutation of mutations) {
    if (mutation.args === undefined || typeof mutation.predict !== "function") {
      throw new Error(`Invalid mutation definition: ${mutation.name}`)
    }
    if (names.has(mutation.name)) {
      throw new Error(`Duplicate mutation name: ${mutation.name}`)
    }
    names.add(mutation.name)
  }

  return Object.freeze({ id: definition.id, mutations })
}
