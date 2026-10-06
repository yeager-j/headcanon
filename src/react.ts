"use client"

import { createContext, createElement, useContext, type ReactNode } from "react"
import type { Result } from "serializable-result"

import type { MutationEnvelope } from "./core/authority"
import type { InvalidationAdapter } from "./core/invalidation"
import type {
  AnyMutationDefinition,
  InvocationOf,
  MutationErrorOf,
  ProtocolDefinition,
  ProtocolInvocation,
} from "./core/protocol"
import type { AcceptedStamp, AxisId, Canon } from "./core/revisions"
import {
  createPredictedRootHook,
  type ErrorOf,
  type MutationOf,
  type StateOf,
  type TerminalDeliveryFailure,
} from "./predicted-root"
import {
  useIncorporation,
  type IncorporationStatus,
  type RefreshAdapter,
  type RefreshStallReason,
} from "./refresh"

/** Terminal lifecycle failures surfaced by a predicted root's receipts. */
export type MutationLifecycleError<Error> =
  | { readonly kind: "domain"; readonly error: Error }
  | { readonly kind: "replay-refused"; readonly error: Error }
  | { readonly kind: "delivery-cancelled" }
  | TerminalDeliveryFailure
  | {
      readonly kind: "root-unmounted"
      readonly outcome: "unknown" | "accepted"
    }

/** Independent acceptance and canonization milestones for one mutation. */
export interface MutationReceipt<Error> {
  readonly id: string
  readonly accepted: Promise<
    Result<AcceptedStamp, MutationLifecycleError<Error>>
  >
  readonly canonized: Promise<Result<void, MutationLifecycleError<Error>>>
}

/** Observers for the three mutation stages represented by a receipt. */
export interface MutationStageListeners<Error> {
  /** Called immediately with the local prediction result. */
  readonly onPrediction?: (
    result: Result<MutationReceipt<Error>, Error>
  ) => void
  /** Called when the authority accepts or refuses the mutation. */
  readonly onAcceptance?: (
    result: Result<AcceptedStamp, MutationLifecycleError<Error>>
  ) => void
  /** Called when acceptance is incorporated into canon, or can no longer be. */
  readonly onCanonization?: (
    result: Result<void, MutationLifecycleError<Error>>
  ) => void
}

/** A pending invocation jossed while replaying newer authoritative canon. */
export interface ReplayConflict<Invocation, Error> {
  readonly mutationId: string
  readonly invocation: Invocation
  readonly error: Error
}

/** State and controls exposed by a mounted optimistic predicted root. */
export interface PredictedRoot<State, Invocation, Error> {
  readonly value: State
  readonly mutate: (
    invocation: Invocation,
    listeners?: MutationStageListeners<Error>
  ) => Result<MutationReceipt<Error>, Error>
  readonly retryDelivery: () => void
  readonly retryRefresh: () => void
  readonly status: {
    readonly pending: number
    readonly delivery: "idle" | "sending" | "uncertain"
  } & IncorporationStatus
  /** The most recent replay conflicts (up to 50), oldest first. */
  readonly conflicts: readonly ReplayConflict<Invocation, Error>[]
}

/** Read-only state and lifecycle controls exposed by an observed root. */
export interface ObservedRoot<State> {
  readonly value: State
  readonly retryRefresh: () => void
  readonly status: IncorporationStatus
}

/** Human-readable identity used in generated provider names and missing-provider errors. */
export interface PredictedRootContextOptions {
  readonly name: string
}

type MutationForInvocation<Protocol, Invocation> =
  MutationOf<Protocol> extends infer Mutation
    ? Mutation extends AnyMutationDefinition
      ? Invocation extends InvocationOf<Mutation>
        ? Mutation
        : never
      : never
    : never

type ErrorForInvocation<Protocol, Invocation> = MutationErrorOf<
  MutationForInvocation<Protocol, Invocation>
>

/** Protocol-specialized predicted-root shape with correlated mutation errors. */
export type ProtocolPredictedRoot<
  Protocol extends ProtocolDefinition<string, readonly AnyMutationDefinition[]>,
> = Omit<
  PredictedRoot<
    StateOf<Protocol>,
    ProtocolInvocation<Protocol>,
    ErrorOf<Protocol>
  >,
  "mutate"
> & {
  readonly mutate: <Invocation extends ProtocolInvocation<Protocol>>(
    invocation: Invocation,
    listeners?: MutationStageListeners<ErrorForInvocation<Protocol, Invocation>>
  ) => Result<
    MutationReceipt<ErrorForInvocation<Protocol, Invocation>>,
    ErrorForInvocation<Protocol, Invocation>
  >
}

/** Protocol, delivery, refresh, and invalidation dependencies for a root factory. */
export interface PredictedRootOptions<
  Protocol extends ProtocolDefinition<string, readonly AnyMutationDefinition[]>,
> {
  readonly protocol: Protocol
  /**
   * Delivers one envelope after framework control-flow throws have been
   * classified. An ordinary throw at this seam means delivery is uncertain
   * (the commit may exist). Throw {@link RetryableDeliveryError} instead when
   * the authority verifiably stored no receipt and the same envelope should
   * simply be redelivered (exhausted contention), and
   * {@link TerminalDeliveryError} when the authority's answer is final but is
   * not a domain refusal (a denial, or an executor refusal of the envelope).
   */
  readonly send: (
    envelope: MutationEnvelope<ProtocolInvocation<Protocol>>
  ) => Promise<Result<AcceptedStamp, ErrorOf<Protocol>>>
  readonly refresh: () => RefreshAdapter
  readonly invalidations?: InvalidationAdapter
  /** Default stage observers used when a mutate call does not override a stage. */
  readonly mutationListeners?: MutationStageListeners<ErrorOf<Protocol>>
  /** Default root-recovery observers used when a mounted root does not override a condition. */
  readonly recoveryListeners?: PredictedRootRecoveryListeners<
    ProtocolInvocation<Protocol>,
    ErrorOf<Protocol>
  >
}

/** Latest complete authoritative canon supplied to a mounted root. */
export interface PredictedRootInput<
  State,
  Invocation = unknown,
  Error = unknown,
> {
  /**
   * The current complete authoritative canon. Keep it **referentially stable
   * per authoritative observation** — RSC props and snapshot state naturally
   * are. A void refresh carrier counts a new canon object as the delivery it
   * asked for, and every new object re-folds the pending predictions.
   */
  readonly canon: Canon<State>
  /** Root-recovery observers scoped to this mounted aggregate. */
  readonly recoveryListeners?: PredictedRootRecoveryListeners<Invocation, Error>
}

/**
 * The public hook type returned by a predicted-root factory. Its protocol fixes
 * the canon state, invocation union, and correlated mutation error types.
 * @param input Current complete authoritative canon.
 * @returns Protocol-specialized predicted root state and controls.
 */
export type PredictedRootHook<
  Protocol extends ProtocolDefinition<string, readonly AnyMutationDefinition[]>,
> = (
  input: PredictedRootInput<
    StateOf<Protocol>,
    ProtocolInvocation<Protocol>,
    ErrorOf<Protocol>
  >
) => ProtocolPredictedRoot<Protocol>

/** Props accepted by a generated predicted-root provider. */
export type PredictedRootProviderProps<
  Protocol extends ProtocolDefinition<string, readonly AnyMutationDefinition[]>,
> = Parameters<PredictedRootHook<Protocol>>[0] & {
  readonly children: ReactNode
}

/** One mounted predicted-root provider and its context-bound consumer hook. */
export interface PredictedRootContext<
  Protocol extends ProtocolDefinition<string, readonly AnyMutationDefinition[]>,
> {
  readonly Provider: (props: PredictedRootProviderProps<Protocol>) => ReactNode
  readonly useRoot: () => ProtocolPredictedRoot<Protocol>
}

/** Delivery recovery controls supplied while the queue head is uncertain. */
export interface DeliveryRecovery {
  readonly retry: () => void
}

/** Canon recovery facts supplied while authoritative incorporation is stalled. */
export interface FreshnessRecovery {
  readonly retry: () => void
  readonly reason: RefreshStallReason
  readonly missingAxes: readonly AxisId[]
}

/** Application-owned listeners for a predicted root's degraded states and conflicts. */
export interface PredictedRootRecoveryListeners<Invocation, Error> {
  readonly onDeliveryUncertain?: (
    recovery: DeliveryRecovery
  ) => void | (() => void)
  readonly onFreshnessStalled?: (
    recovery: FreshnessRecovery
  ) => void | (() => void)
  readonly onConflict?: (conflict: ReplayConflict<Invocation, Error>) => void
}

/**
 * Creates one context-owned predicted-root lifetime for a React subtree.
 * Calling a predicted-root hook more than once creates independent queues and
 * receipt ledgers; this provider mounts it once and every `useRoot` consumer
 * receives that exact root. Key the provider when one component instance can
 * switch between logical aggregates.
 *
 * @param usePredictedRoot Protocol-specialized root hook to mount once.
 * @param options Human-readable context identity for React tools and errors.
 * @returns A provider that accepts the latest canon and a context-bound root hook.
 */
export function createPredictedRootContext<
  const Protocol extends ProtocolDefinition<
    string,
    readonly AnyMutationDefinition[]
  >,
>(
  usePredictedRoot: PredictedRootHook<Protocol>,
  options: PredictedRootContextOptions
): PredictedRootContext<Protocol> {
  type Root = ProtocolPredictedRoot<Protocol>

  const missingRoot = Symbol(options.name)
  const Context = createContext<Root | typeof missingRoot>(missingRoot)
  Context.displayName = options.name

  function Provider({
    canon,
    recoveryListeners,
    children,
  }: PredictedRootProviderProps<Protocol>): ReactNode {
    const root = usePredictedRoot({ canon, recoveryListeners })
    return createElement(Context.Provider, { value: root }, children)
  }
  Provider.displayName = `${options.name}.Provider`

  function useRoot(): Root {
    const root = useContext(Context)
    if (root === missingRoot) {
      throw new Error(
        `${options.name}.useRoot must be used within ${options.name}.Provider`
      )
    }
    return root
  }

  return Object.freeze({ Provider, useRoot })
}

/** Refresh and optional invalidation dependencies for an observed root. */
export interface ObservedRootOptions {
  readonly refresh: () => RefreshAdapter
  readonly invalidations?: InvalidationAdapter
}

/**
 * Creates a framework-independent React predicted-root hook.
 *
 * The returned hook keeps the latest complete `Canon` as the authoritative
 * base and folds every live prediction over it in invocation order. A
 * successful local prediction returns a receipt with independent `accepted`
 * and `canonized` promises: acceptance means the authority committed an
 * `AcceptedStamp`, while canonization waits until this root's canon covers
 * that stamp. The prediction renders until then, however long the refresh
 * carrier takes. Delivery is serialized in invocation order; each attempt
 * holds a React Action open for at most {@link DELIVERY_WAIT_MS}, uncertain
 * envelopes keep their mutation ID for an exact retry, and replay-refused
 * predictions are reported as conflicts rather than silently disappearing.
 * Callers own the refresh carrier, optional invalidation transport, and
 * application-owned listeners; the root owns subscription and listener
 * cleanup plus pending-receipt settlement on unmount.
 *
 * @param options Protocol, delivery, refresh, invalidation, and listener configuration.
 * @returns A hook exposing predicted state, mutation receipts, retry controls, and status.
 */
export function createPredictedRoot<
  const Protocol extends ProtocolDefinition<
    string,
    readonly AnyMutationDefinition[]
  >,
>(options: PredictedRootOptions<Protocol>): PredictedRootHook<Protocol> {
  return createPredictedRootHook(options, () => undefined)
}

/**
 * Creates a read-only React observed-root hook.
 * @param options Refresh and optional invalidation dependencies.
 * @returns A hook exposing authoritative state and incorporation status without mutation controls.
 */
export function createObservedRoot(options: ObservedRootOptions) {
  return function useObservedRoot<State>({
    canon,
  }: {
    readonly canon: Canon<State>
  }): ObservedRoot<State> {
    const useRefresh = options.refresh
    const refresh = useRefresh()
    const incorporation = useIncorporation(
      canon,
      refresh,
      options.invalidations
    )

    return {
      value: canon.value,
      retryRefresh: incorporation.retryRefresh,
      status: incorporation.status,
    }
  }
}

export {
  DELIVERY_WAIT_MS,
  RetryableDeliveryError,
  TerminalDeliveryError,
  type TerminalDeliveryFailure,
} from "./predicted-root"

// The invalidation vocabulary and `MutationEnvelope` have one public home,
// the framework-independent `headcanon` entry.
export {
  useSnapshotRefresh,
  type FreshnessState,
  type FreshnessStatus,
  type IncorporationStatus,
  type RefreshAdapter,
  type RefreshStallReason,
} from "./refresh"
