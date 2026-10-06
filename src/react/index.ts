"use client"

import { createContext, createElement, useContext, type ReactNode } from "react"

import type { InvalidationAdapter } from "../core/invalidation"
import type {
  AnyMutationDefinition,
  ProtocolDefinition,
} from "../core/protocol"
import type { Canon } from "../core/revisions"
import {
  createPredictedRootHook,
  type PredictedRootHook,
  type PredictedRootOptions,
  type ProtocolPredictedRoot,
} from "./predicted-root"
import {
  useIncorporation,
  type IncorporationStatus,
  type RefreshAdapter,
} from "./refresh"

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
  type MutationLifecycleError,
  type MutationReceipt,
  type ReplayConflict,
  type TerminalDeliveryFailure,
} from "./ledger"
export type {
  DeliveryRecovery,
  FreshnessRecovery,
  MutationStageListeners,
  PredictedRoot,
  PredictedRootHook,
  PredictedRootInput,
  PredictedRootOptions,
  PredictedRootRecoveryListeners,
  ProtocolPredictedRoot,
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
