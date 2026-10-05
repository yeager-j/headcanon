import { createHash, randomUUID } from "node:crypto"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import { cacheTag, refresh, revalidateTag, updateTag } from "next/cache"
import { forbidden } from "next/navigation"

import { err, ok, type Result } from "@workspace/result"

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
import type {
  AnyMutationDefinition,
  MutationRefusalOf,
  ProtocolDefinition,
} from "../protocol"
import {
  axisId,
  type AcceptedStamp,
  type AxisId,
  type RevisionVector,
} from "../revisions"

/** Maximum axis count supported by one Next cache-tagged versioned base. */
export const MAX_VERSIONED_BASE_AXES = 128

const AXIS_CACHE_TAG_PREFIX = "headcanon:axis:v1:"
const INVALIDATION_PUBLICATION_TIMEOUT_MS = 1_000

/** Derives the one bounded, versioned cache tag owned by an axis.
 * @param axis Axis address to hash.
 * @returns Stable cache tag for the axis.
 */
export function axisCacheTag(axis: AxisId): string {
  const digest = createHash("sha256").update(axis, "utf8").digest("hex")
  return `${AXIS_CACHE_TAG_PREFIX}${digest}`
}

/** Applies every observed axis tag to one Cache Components entry.
 * @param base Versioned base whose revisions identify cache tags.
 * @returns The same base, after registering its cache tags.
 * @throws RangeError when the base exceeds the Next tag limit.
 */
export function tagVersionedBase<
  Base extends { readonly revisions: RevisionVector },
>(base: Base): Base {
  const axes = Object.keys(base.revisions).map(axisId)
  if (axes.length > MAX_VERSIONED_BASE_AXES) {
    throw new RangeError(
      `A versioned base may observe at most ${MAX_VERSIONED_BASE_AXES} axes; received ${axes.length}`
    )
  }

  cacheTag(...axes.map(axisCacheTag))
  return base
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

async function finalizeStamp(
  stamp: AcceptedStamp,
  invalidations: InvalidationPublisher,
  expireAxis: ExpireAxis,
  reportFailure: InvalidationPublicationFailureReporter,
  refreshRoute?: () => void
): Promise<void> {
  for (const rawAxis of Object.keys(stamp.revisions)) {
    expireAxis(axisCacheTag(axisId(rawAxis)))
  }

  refreshRoute?.()
  await publishInvalidation(stamp, invalidations, reportFailure)
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
  return finalizeStamp(stamp, invalidations, updateTag, reportFailure, refresh)
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
    invalidations,
    (tag) => revalidateTag(tag, { expire: 0 }),
    reportFailure
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

/** The application command's terminal decision inside one authority attempt. */
export type MutationCommandDecision<Refusal> =
  | { readonly kind: "accepted" }
  | { readonly kind: "refused"; readonly error: Refusal }
  | { readonly kind: "denied" }

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
   * receipt. Implementations must be repeat-safe.
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

/**
 * UNN-688 spike: an application-scoped command definer. The application
 * decides its actor, preflight, and transaction types once — where its
 * authority context is created — and every command literal is then fully
 * contextually typed with only mutation, projection, and evidence left to
 * infer. `defineMutationCommand(mutation, command)` produces the same frozen
 * binding as `bindMutation` and preserves its wrong-definition negative
 * typecheck; if adopted, it replaces `bindMutation` rather than joining it.
 * @returns A contextually typed command-binding factory.
 */
export function createMutationCommandDefiner<Actor, Preflight, Transaction>() {
  return function defineMutationCommand<
    const Mutation extends MutationWithRefusal,
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
    MutationCommand<
      Mutation,
      Actor,
      Preflight,
      Transaction,
      Projection,
      Evidence
    >
  > {
    return Object.freeze({ mutation, command })
  }
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

type RuntimeCommand<Actor, Preflight, Transaction, Refusal> = {
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
  }) =>
    | MutationCommandDecision<Refusal>
    | Promise<MutationCommandDecision<Refusal>>
  readonly finalizeAccepted?: (context: {
    readonly actor: Actor
    readonly args: unknown
    readonly stamp: AcceptedStamp
    readonly projection: unknown
  }) => void | Promise<void>
}

interface RuntimeBinding<Actor, Preflight, Transaction, Refusal> {
  readonly mutation: MutationWithRefusal
  readonly command: RuntimeCommand<Actor, Preflight, Transaction, Refusal>
}

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
    if (protocol.mutationsByName[mutation.name] !== mutation) {
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
 * Creates one Server Action from an exhaustive, definition-keyed command list.
 *
 * The returned action treats its argument as untrusted: it parses the envelope,
 * revalidates arguments, derives canonical identity, and resolves the matching
 * command by mutation-definition identity. It derives the actor from the
 * supplied trusted callback, runs screening before receipt ownership, and runs
 * admission plus execution inside the authority's retryable transaction
 * attempts. The authority owns receipt deduplication and contention; commands
 * own application authorization, domain writes, axis stamping, and the
 * repeat-safe `finalizeAccepted` projection. Accepted finalization is
 * intentionally at-least-once because a redelivery may recover a stored
 * receipt. The action expires affected Next cache tags, refreshes the invoking
 * route, and publishes invalidations after acceptance; publication failures go
 * only to the supplied reporter and do not turn an accepted mutation into a
 * rejection.
 *
 * @param options Protocol, trusted actor, authority, exhaustive commands, invalidation publisher, and failure reporter.
 * @returns A protocol-branded Server Action returning terminal outcomes or typed executor failures.
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
>(options: {
  readonly protocol: Protocol
  readonly actor: () => Actor | Promise<Actor>
  readonly authority: MutationAuthorityAdapter<
    Transaction,
    Actor,
    unknown,
    Preflight
  > & { readonly preflight: Preflight }
  readonly commands: Commands &
    CompleteBindings<Protocol, Commands> &
    CompatibleBindings<Commands, Actor, Preflight, Transaction>
  readonly invalidations: InvalidationPublisher
  readonly reportInvalidationFailure: InvalidationPublicationFailureReporter
}) {
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
    Result<
      Exclude<Terminal, { readonly kind: "denied" }>,
      MutationExecutorError
    > &
      ProtocolIdentity<Protocol["id"]>
  > => {
    const actor = await options.actor()
    const prepared = await prepareMutationRequest(options.protocol, envelope)
    if (!prepared.ok) return prepared

    const binding = bindings.get(prepared.value.mutation)
    if (!binding) {
      throw new Error(`Missing mutation binding: ${prepared.value.mutation}`)
    }
    const args = structuredClone(prepared.value.args)
    const screening = await binding.command.screen({
      executor: options.authority.preflight,
      actor,
      args,
    })
    if (screening.kind === "denied") forbidden()

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
      parseRejection: (value) =>
        parseMutationRefusal<Refusal>(binding.mutation.refusal, value),
      run: async (tx, stamp, attemptArgs) => {
        const admitted = await binding.command.admit({
          tx,
          actor,
          args: attemptArgs,
        })
        if (admitted.kind === "denied") {
          return err({
            kind: "denied",
          } satisfies MutationAttemptFailure<Refusal>)
        }

        const decision = await binding.command.execute({
          tx,
          actor,
          args: attemptArgs,
          evidence: admitted.evidence,
          stamp,
          mutationId: prepared.value.mutationId,
        })
        if (decision.kind === "accepted") return ok(undefined)
        return err(
          decision.kind === "denied"
            ? ({ kind: "denied" } satisfies MutationAttemptFailure<Refusal>)
            : ({
                kind: "refused",
                error: decision.error,
              } satisfies MutationAttemptFailure<Refusal>)
        )
      },
    })
    if (!outcome.ok) return outcome
    if (outcome.value.kind === "denied") forbidden()
    if (outcome.value.kind === "rejected") return ok(outcome.value)

    await finalizeExternalActionCommit(
      outcome.value.stamp,
      options.invalidations,
      options.reportInvalidationFailure
    )
    await binding.command.finalizeAccepted?.({
      actor,
      args,
      stamp: outcome.value.stamp,
      projection: screening.projection,
    })
    return ok(outcome.value)
  }
}
