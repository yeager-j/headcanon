import { randomUUID } from "node:crypto"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import { cacheTag, refresh, revalidateTag, updateTag } from "next/cache"
import { err, ok, type Result } from "serializable-result"

import {
  executePreparedMutation,
  prepareMutationRequest,
  type MutationAttemptFailure,
  type MutationAuthorityAdapter,
  type MutationExecutorError,
  type MutationTerminalOutcome,
  type ProtocolIdentity,
  type StampAccumulator,
} from "../authority"
import type {
  InvalidationPublicationFailureReporter,
  InvalidationPublisher,
} from "../invalidation"
import {
  findMutation,
  type AnyMutationDefinition,
  type MutationRefusalOf,
  type ProtocolDefinition,
} from "../protocol"
import {
  defineCanon,
  revisionEntries,
  type AcceptedStamp,
  type AxisId,
  type Canon,
} from "../revisions"
import { sha256Hex } from "../sha256"

/** Maximum axis count supported by one Next cache-tagged versioned base. */
export const MAX_VERSIONED_BASE_AXES = 128

const AXIS_CACHE_TAG_PREFIX = "headcanon:axis:v1:"
const INVALIDATION_PUBLICATION_TIMEOUT_MS = 1_000

/** Derives the one bounded, versioned cache tag owned by an axis.
 * @param axis Axis address to hash.
 * @returns A promise for the stable cache tag of the axis.
 */
export async function axisCacheTag(axis: AxisId): Promise<string> {
  return `${AXIS_CACHE_TAG_PREFIX}${await sha256Hex(axis)}`
}

/** Parses a `"use cache"` loader's observation into a canon and applies every
 * observed axis tag to its Cache Components entry. It is the cached
 * counterpart of `defineCanon` and runs the same parse.
 * @param input Loader value and raw axis revisions observed together.
 * @returns A promise for the frozen canon, after registering its cache tags.
 * @throws Error when the supplied revision vector is invalid.
 * @throws RangeError when the base exceeds the Next tag limit.
 */
export async function tagVersionedBase<State>(input: {
  readonly value: State
  readonly revisions: Readonly<Record<string, number>>
}): Promise<Canon<State>> {
  const canon = defineCanon(input)
  const axes = revisionEntries(canon.revisions).map(([axis]) => axis)
  if (axes.length > MAX_VERSIONED_BASE_AXES) {
    throw new RangeError(
      `A versioned base may observe at most ${MAX_VERSIONED_BASE_AXES} axes; received ${axes.length}`
    )
  }

  cacheTag(...(await Promise.all(axes.map(axisCacheTag))))
  return canon
}

type ExpireAxis = (tag: string) => void

function recordPublicationFailure(
  reportFailure: InvalidationPublicationFailureReporter,
  failure: Parameters<InvalidationPublicationFailureReporter>[0]
): void {
  try {
    reportFailure(failure)
  } catch {
    // Diagnostics remain advisory just like the publication they observe.
  }
}

async function publishInvalidation(
  stamp: AcceptedStamp,
  invalidations: InvalidationPublisher,
  reportFailure: InvalidationPublicationFailureReporter
): Promise<void> {
  const eventId = randomUUID()
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<"timed-out">((resolve) => {
    timeout = setTimeout(
      () => resolve("timed-out"),
      INVALIDATION_PUBLICATION_TIMEOUT_MS
    )
  })

  try {
    const outcome = await Promise.race([
      Promise.resolve()
        .then(() => invalidations.publish(eventId, stamp))
        .then(() => "published" as const),
      timedOut,
    ])
    if (outcome === "timed-out") {
      recordPublicationFailure(reportFailure, {
        kind: "timed-out",
        eventId,
        stamp,
      })
    }
  } catch (error) {
    recordPublicationFailure(reportFailure, {
      kind: "rejected",
      eventId,
      stamp,
      error,
    })
  } finally {
    clearTimeout(timeout)
  }
}

/** A realtime publisher and the sink for its failures; absent without realtime. */
interface Publication {
  readonly invalidations: InvalidationPublisher
  readonly reportFailure: InvalidationPublicationFailureReporter
}

async function finalizeStamp(
  stamp: AcceptedStamp,
  expireAxis: ExpireAxis,
  refreshRoute: (() => void) | undefined,
  publication: Publication | undefined
): Promise<void> {
  for (const [axis] of revisionEntries(stamp.revisions)) {
    expireAxis(await axisCacheTag(axis))
  }

  refreshRoute?.()
  if (publication) {
    await publishInvalidation(
      stamp,
      publication.invalidations,
      publication.reportFailure
    )
  }
}

/** Finalizes a non-protocol commit made inside a Server Action.
 * @param stamp Accepted revisions advanced by the commit.
 * @param invalidations Application-owned invalidation publisher.
 * @param reportFailure Diagnostic sink for publication failures.
 * @returns Completion of cache expiry, route refresh, and bounded publication.
 */
export function finalizeExternalActionCommit(
  stamp: AcceptedStamp,
  invalidations: InvalidationPublisher,
  reportFailure: InvalidationPublicationFailureReporter
): Promise<void> {
  return finalizeStamp(stamp, updateTag, refresh, {
    invalidations,
    reportFailure,
  })
}

/** Finalizes a non-protocol commit without an invoking route to refresh.
 * @param stamp Accepted revisions advanced by the commit.
 * @param invalidations Application-owned invalidation publisher.
 * @param reportFailure Diagnostic sink for publication failures.
 * @returns Completion of cache expiry and bounded publication.
 */
export function announceExternalCommit(
  stamp: AcceptedStamp,
  invalidations: InvalidationPublisher,
  reportFailure: InvalidationPublicationFailureReporter
): Promise<void> {
  return finalizeStamp(
    stamp,
    (tag) => revalidateTag(tag, { expire: 0 }),
    undefined,
    { invalidations, reportFailure }
  )
}

type MutationWithRefusal = AnyMutationDefinition & {
  readonly refusal: StandardSchemaV1
}

type MutationArgs<Mutation extends AnyMutationDefinition> = Mutation extends (
  args: infer Args
) => unknown
  ? Args
  : never

type ProtocolMutation<Protocol> =
  Protocol extends ProtocolDefinition<string, infer Mutations>
    ? Mutations[number]
    : never

/** Immutable application context retained for repeat-safe accepted projections. */
export type MutationScreening<Projection> =
  | { readonly kind: "allowed"; readonly projection: Projection }
  | { readonly kind: "denied" }

/** Evidence that transactional admission succeeded for one authority attempt. */
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

/** Marks preflight screening as allowed and carries its repeat-safe projection.
 * @param projection Repeat-safe projection retained for accepted finalization.
 * @returns An allowed screening decision.
 */
export function allowMutationScreening<Projection>(
  projection: Projection
): MutationScreening<Projection> {
  return Object.freeze({ kind: "allowed", projection })
}

/** Returns the private denial decision, which is not exposed as a refusal.
 * @returns A denied command decision.
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
  Projection,
  Evidence,
> {
  readonly screen: (context: {
    readonly executor: Preflight
    readonly actor: Actor
    readonly args: MutationArgs<Mutation>
  }) => MutationScreening<Projection> | Promise<MutationScreening<Projection>>
  readonly admit: (context: {
    readonly tx: Transaction
    readonly actor: Actor
    readonly args: MutationArgs<Mutation>
  }) => MutationAdmission<Evidence> | Promise<MutationAdmission<Evidence>>
  readonly execute: (context: {
    readonly tx: Transaction
    readonly actor: Actor
    readonly args: MutationArgs<Mutation>
    readonly evidence: Evidence
    readonly stamp: StampAccumulator
    /** The package-owned identity parsed from the invocation envelope. */
    readonly mutationId: string
  }) =>
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
    readonly projection: Projection
  }) => void | Promise<void>
}

/** Definition-keyed association between one mutation and its application command. */
export interface MutationBinding<
  Mutation extends MutationWithRefusal,
  Command = unknown,
> {
  readonly mutation: Mutation
  readonly command: Command
}

/** Binds by definition identity, preserving the mutation's exact argument type.
 * @param mutation Client-safe mutation definition.
 * @param command Application-owned command for that exact definition.
 * @returns A frozen mutation-command binding.
 */
export function bindMutation<
  const Mutation extends MutationWithRefusal,
  Actor,
  Preflight,
  Transaction,
  Projection,
  Evidence,
>(
  mutation: Mutation,
  command: MutationCommand<
    NoInfer<Mutation>,
    Actor,
    Preflight,
    Transaction,
    Projection,
    Evidence
  >
): MutationBinding<
  Mutation,
  MutationCommand<Mutation, Actor, Preflight, Transaction, Projection, Evidence>
> {
  return Object.freeze({ mutation, command })
}

type AnyMutationBinding = MutationBinding<MutationWithRefusal>

type BoundMutation<Commands extends readonly AnyMutationBinding[]> =
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

type CompatibleBindings<
  Commands extends readonly AnyMutationBinding[],
  Actor,
  Preflight,
  Transaction,
> = Commands extends readonly [
  infer First extends AnyMutationBinding,
  ...infer Rest extends readonly AnyMutationBinding[],
]
  ? First extends MutationBinding<infer Mutation, infer Command>
    ? Command extends MutationCommand<
        Mutation,
        Actor,
        Preflight,
        Transaction,
        infer _Projection,
        infer _Evidence
      >
      ? CompatibleBindings<Rest, Actor, Preflight, Transaction>
      : { readonly __incompatibleMutationCommand: never }
    : { readonly __incompatibleMutationCommand: never }
  : unknown

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

function parseMutationRefusal<Refusal>(
  schema: StandardSchemaV1,
  value: unknown
): Refusal {
  const parsed = schema["~standard"].validate(value)
  if ("then" in parsed) {
    throw new Error("Mutation refusal codecs must validate synchronously")
  }
  if (parsed.issues) throw new Error("Invalid stored mutation refusal")
  return parsed.value as Refusal
}

function assertCompleteBindings(
  protocol: ProtocolDefinition<string, readonly AnyMutationDefinition[]>,
  commands: readonly AnyMutationBinding[]
): void {
  const expected = new Set(protocol.mutations.map(({ name }) => name))
  const registered = new Set<string>()

  for (const { mutation } of commands) {
    if (registered.has(mutation.name)) {
      throw new Error(`Duplicate mutation binding: ${mutation.name}`)
    }
    if (findMutation(protocol, mutation.name) !== mutation) {
      throw new Error(
        `Mutation binding does not use the protocol definition: ${mutation.name}`
      )
    }
    registered.add(mutation.name)
  }

  const missing = [...expected].filter((name) => !registered.has(name))
  const unknown = [...registered].filter((name) => !expected.has(name))
  if (missing.length === 0 && unknown.length === 0) return

  throw new Error(
    `Incomplete mutation bindings: missing [${missing.join(", ")}], unknown [${unknown.join(", ")}]`
  )
}

/**
 * A generated action's realtime publication: a publisher with its failure
 * reporter, or neither when the application has no realtime transport.
 */
type ActionInvalidations =
  | {
      readonly invalidations: InvalidationPublisher
      readonly reportInvalidationFailure: InvalidationPublicationFailureReporter
    }
  | {
      readonly invalidations?: undefined
      readonly reportInvalidationFailure?: undefined
    }

/**
 * Creates one Server Action from an exhaustive, definition-keyed command list.
 *
 * The returned action treats its argument as untrusted: it parses the envelope,
 * revalidates arguments, derives canonical identity, and resolves the matching
 * command by mutation-definition identity before it derives the actor from the
 * supplied trusted callback, so a malformed request never reaches application
 * code. It runs screening before receipt ownership, and runs admission plus
 * execution inside the authority's retryable transaction attempts. Every
 * command callback receives its own copy of the parsed arguments. The
 * authority owns receipt deduplication and contention; commands own
 * application authorization, domain writes, axis stamping, and the
 * repeat-safe `finalizeAccepted` projection.
 *
 * A denial, from screening or from a recorded transaction-time admission,
 * returns `ok({ kind: "denied" })`. It carries no reason, so it reveals no
 * more than an HTTP 403, and it needs no Next configuration: the action does
 * not throw Next's experimental `forbidden()`, which fails unless
 * `experimental.authInterrupts` is enabled. A screening denial claims no
 * receipt; a recorded denial replays on redelivery.
 *
 * After acceptance the action first runs `finalizeAccepted`, then expires
 * the affected Next cache tags, refreshes the invoking route, and publishes
 * invalidations. That order lets a projection write what readers load before
 * any reader is told to reload. If `finalizeAccepted` throws, the action still
 * expires, refreshes, and publishes, because the commit exists, and then
 * rethrows; a redelivery recovers the stored receipt and reruns the
 * projection, so accepted finalization is at-least-once. Publication failures
 * go only to the supplied reporter and do not turn an accepted mutation into a
 * rejection. Omit both `invalidations` and `reportInvalidationFailure` when
 * the application has no realtime transport: the action then only expires
 * tags and refreshes, and the router carries canon back.
 *
 * @param options Protocol, trusted actor, authority, exhaustive commands, and optionally an invalidation publisher with its failure reporter.
 * @returns A protocol-branded Server Action returning terminal outcomes (`accepted`, `refused`, or `denied`) or typed executor failures.
 * @throws Trusted actor or command callbacks may throw unexpected application/framework failures.
 */
export function createNextMutationAction<
  const Protocol extends ProtocolDefinition<
    string,
    readonly AnyMutationDefinition[]
  >,
  Transaction,
  Actor,
  Preflight,
  const Commands extends readonly AnyMutationBinding[],
>(
  options: {
    readonly protocol: Protocol
    readonly actor: () => Actor | Promise<Actor>
    readonly authority: MutationAuthorityAdapter<
      Transaction,
      Actor,
      unknown,
      Preflight
    >
    readonly commands: Commands &
      CompleteBindings<Protocol, Commands> &
      CompatibleBindings<Commands, Actor, Preflight, Transaction>
  } & ActionInvalidations
) {
  type Refusal = MutationRefusalOf<BoundMutation<Commands>>
  type Terminal = MutationTerminalOutcome<Refusal>

  assertCompleteBindings(options.protocol, options.commands)
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
    const actor = await options.actor()
    const screening = await binding.command.screen({
      executor: options.authority.preflight,
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
      authority: options.authority as MutationAuthorityAdapter<
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
        projection: screening.projection,
      })
    } finally {
      await finalizeStamp(
        stamp,
        updateTag,
        refresh,
        options.invalidations === undefined
          ? undefined
          : {
              invalidations: options.invalidations,
              reportFailure: options.reportInvalidationFailure,
            }
      )
    }
    return outcome
  }
}
