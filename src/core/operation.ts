import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { Result } from "serializable-result"

import type {
  AdmissionRegistry,
  MutationAttemptFailure,
  MutationEnvelope,
  MutationExecutorError,
  ProtocolIdentity,
} from "./authority"
import {
  deepFreeze,
  NO_REFUSALS,
  OPERATION_PROTOCOL_ID,
  type MutationInvocation,
  type NoRefusalSchema,
  type ParsedFormSchema,
} from "./protocol"
import type { AcceptedStamp } from "./revisions"

/** The result schema type of an operation that declares no result. */
export type NoResultSchema = StandardSchemaV1<undefined, undefined>

/**
 * The result schema {@link defineOperation} gives an operation that declares
 * none. It accepts only `undefined`, so a stored result for such an operation
 * fails closed.
 */
const NO_RESULT: NoResultSchema = Object.freeze({
  "~standard": Object.freeze({
    version: 1,
    vendor: "headcanon",
    validate: (value: unknown) =>
      value === undefined
        ? { value: undefined }
        : { issues: [{ message: "This operation declares no result" }] },
  }),
})

/**
 * A write outside a protocol, shared by client and server: its stable wire
 * name and the schemas of its arguments, its accepted result, and its public
 * refusals. Nothing predicts it; the client waits for the server's answer.
 */
export interface OperationDefinition<
  Name extends string,
  ArgsSchema extends StandardSchemaV1,
  ResultSchema extends StandardSchemaV1 = NoResultSchema,
  RefusalSchema extends StandardSchemaV1 = NoRefusalSchema,
> {
  /** The stable wire name. It is part of every receipt's identity. */
  readonly name: Name
  readonly args: ArgsSchema
  /** Parses the result an acceptance returns and its receipt replays. */
  readonly result: ResultSchema
  /** Parses the refusals a receipt stores and replays. */
  readonly refusal: RefusalSchema
}

/** Any operation definition: the constraint for code generic over operations. */
export type AnyOperationDefinition = OperationDefinition<
  string,
  StandardSchemaV1,
  StandardSchemaV1,
  StandardSchemaV1
>

/** An operation's arguments, in their schema's parsed form. */
export type OperationArgsOf<Operation extends AnyOperationDefinition> =
  StandardSchemaV1.InferOutput<Operation["args"]>

/** The result an operation's acceptance carries; `undefined` when it declares none. */
export type OperationResultOf<Operation extends AnyOperationDefinition> =
  StandardSchemaV1.InferOutput<Operation["result"]>

/** An operation's public refusal; `never` when it declares none. */
export type OperationRefusalOf<Operation extends AnyOperationDefinition> =
  StandardSchemaV1.InferOutput<Operation["refusal"]>

/**
 * An operation's terminal outcome, as its receipt records and replays it:
 * accepted with the stamp it advanced and its result, refused, or denied.
 */
export type OperationTerminalOutcome<Result, Refusal> =
  | {
      readonly kind: "accepted"
      readonly stamp: AcceptedStamp
      readonly result: Result
    }
  | MutationAttemptFailure<Refusal>

/**
 * What an operation's generated Server Action returns: its terminal outcome,
 * or an executor error. The phantom identity pairs it with its operation, so
 * a client cannot bind another operation's action.
 */
export type OperationActionOutcome<Operation extends AnyOperationDefinition> =
  Result<
    OperationTerminalOutcome<
      OperationResultOf<Operation>,
      OperationRefusalOf<Operation>
    >,
    MutationExecutorError
  > &
    ProtocolIdentity<`operation:${Operation["name"]}`>

/** The envelope one delivery of an operation carries. */
export type OperationEnvelope<Operation extends AnyOperationDefinition> =
  MutationEnvelope<
    MutationInvocation<Operation["name"], OperationArgsOf<Operation>>
  >

/**
 * Defines one operation's shared client/server contract.
 *
 * Arguments are in the schema's parsed form, as for a mutation: the server
 * parses them again and refuses them unless parsing leaves them unchanged. A
 * schema whose output is not a valid input is a compile error. Omit `result`
 * when an acceptance returns nothing, and `refusal` when the command has no
 * public refusal cases. Result and refusal schemas must validate
 * synchronously, and their values must be JSON serializable. A result
 * schema's output must be a valid input, as an argument schema's must: the
 * command returns the output, and the receipt parses it again on replay. Version the name
 * (`"run.create.v1"`) and change it when the arguments or result change
 * shape: a receipt replays only to a delivery with the same name.
 * @param definition Stable name and the argument, result, and refusal schemas.
 * @returns A frozen operation definition.
 * @throws Error when `name` is empty.
 * @example
 * ```ts
 * export const createRun = defineOperation({
 *   name: "run.create.v1",
 *   args: z.object({ name: z.string() }),
 *   result: z.object({ runId: z.uuid() }),
 * })
 * ```
 */
export function defineOperation<
  const Name extends string,
  ArgsSchema extends StandardSchemaV1,
  ResultSchema extends StandardSchemaV1 = NoResultSchema,
  RefusalSchema extends StandardSchemaV1 = NoRefusalSchema,
>(definition: {
  readonly name: Name
  readonly args: ArgsSchema & ParsedFormSchema<ArgsSchema>
  /** Schema for the result an acceptance returns. Omit it when there is none. */
  readonly result?: ResultSchema & ParsedFormSchema<ResultSchema>
  /** Schema for the public refusals. Omit it when there are none. */
  readonly refusal?: RefusalSchema
}): OperationDefinition<Name, ArgsSchema, ResultSchema, RefusalSchema> {
  if (definition.name === "") throw new Error("An operation needs a name")

  return Object.freeze({
    name: definition.name,
    args: definition.args,
    result: (definition.result ?? NO_RESULT) as ResultSchema,
    refusal: (definition.refusal ?? NO_REFUSALS) as RefusalSchema,
  })
}

/**
 * The registry that admits one operation's envelopes. Not a package export:
 * the operation action parses envelopes with it.
 */
export function operationRegistry(
  operation: AnyOperationDefinition
): AdmissionRegistry {
  return { id: OPERATION_PROTOCOL_ID, mutations: [operation] }
}

/**
 * Builds the envelope for one submission of an operation: a fresh mutation ID
 * and the current time, unless given. Its arguments are a deeply frozen copy.
 * Build it once, when the user submits,
 * and send this same envelope on every retry until the action answers. A new
 * envelope for a submission that may have committed can write twice.
 * @param operation The operation to submit.
 * @param args Arguments in the schema's parsed form.
 * @param identity A mutation ID (a UUID) and `createdAt` (epoch milliseconds) to use instead of fresh ones.
 * @returns A frozen envelope for the operation's Server Action.
 * @throws An error from `structuredClone` when `args` is not plain data.
 * @example
 * ```ts
 * const envelope = createOperationEnvelope(createRun, { name: "Emerald" })
 * let outcome = await createRunAction(envelope).catch(() => undefined)
 * // No answer: send the same envelope again, never a new one.
 * outcome ??= await createRunAction(envelope)
 * ```
 */
export function createOperationEnvelope<
  const Operation extends AnyOperationDefinition,
>(
  operation: Operation,
  args: OperationArgsOf<Operation>,
  identity: { readonly mutationId?: string; readonly createdAt?: number } = {}
): OperationEnvelope<Operation> {
  return Object.freeze({
    protocol: OPERATION_PROTOCOL_ID,
    mutationId: identity.mutationId ?? globalThis.crypto.randomUUID(),
    createdAt: identity.createdAt ?? Date.now(),
    invocation: Object.freeze({
      name: operation.name,
      args: deepFreeze(structuredClone(args)),
    }),
  })
}
