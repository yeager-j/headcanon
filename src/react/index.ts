"use client"

import { createContext, createElement, useContext, type ReactNode } from "react"

import type { InvalidationAdapter } from "../core/invalidation"
import type { AnyProtocolDefinition } from "../core/protocol"
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
  /** The authoritative canon's state. */
  readonly value: State
  /**
   * Refreshes now with a fresh attempt budget when canon does not meet the
   * root's requirements, such as after a stall.
   */
  readonly retryRefresh: () => void
  /** Freshness and invalidation status of the mounted canon. */
  readonly status: IncorporationStatus
}

/** Human-readable identity used in generated provider names and missing-provider errors. */
export interface PredictedRootContextOptions {
  /** Display name for React tools; also names the Provider and the missing-provider error. */
  readonly name: string
}

/** Props accepted by a generated predicted-root provider. */
export type PredictedRootProviderProps<Protocol extends AnyProtocolDefinition> =
  Parameters<PredictedRootHook<Protocol>>[0] & {
    readonly children: ReactNode
  }

/** One mounted predicted-root provider and its context-bound consumer hook. */
export interface PredictedRootContext<Protocol extends AnyProtocolDefinition> {
  /** Mounts one predicted root over `canon` for its subtree. */
  readonly Provider: (props: PredictedRootProviderProps<Protocol>) => ReactNode
  /** Returns the nearest Provider's root. Throws outside a Provider. */
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
 * @example
 * ```tsx
 * const useNotes = createPredictedRoot({
 *   protocol: notesProtocol,
 *   send: sendNotesMutation,
 *   refresh: useNotesRefresh,
 * })
 * const NoteRoot = createPredictedRootContext(useNotes, { name: "NoteRoot" })
 *
 * function NoteSurface({ canon }: { canon: Canon<NotesState> }) {
 *   return (
 *     <NoteRoot.Provider canon={canon}>
 *       <RenameButton />
 *     </NoteRoot.Provider>
 *   )
 * }
 *
 * function RenameButton() {
 *   const { value, mutate } = NoteRoot.useRoot()
 *   const rename = () =>
 *     mutate(renameNote({ noteId: value.focused, title: "Chapter Two" }))
 *   return <button onClick={rename}>Rename</button>
 * }
 * ```
 */
export function createPredictedRootContext<
  const Protocol extends AnyProtocolDefinition,
>(
  usePredictedRoot: PredictedRootHook<Protocol>,
  options: PredictedRootContextOptions
): PredictedRootContext<Protocol> {
  type Root = ProtocolPredictedRoot<Protocol>

  const missingRoot = Symbol(options.name)
  const Context = createContext<Root | typeof missingRoot>(missingRoot)
  Context.displayName = options.name

  function Provider({
    children,
    ...input
  }: PredictedRootProviderProps<Protocol>): ReactNode {
    const root = usePredictedRoot(input)
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
  /**
   * A React hook the root calls during every render to get its refresh
   * carrier. It must follow the Rules of Hooks: pass `useRouterRefresh`, or a
   * function that calls `useSnapshotRefresh`. The adapter returned on the
   * latest render serves each request.
   */
  readonly refresh: () => RefreshAdapter
  /**
   * Push-invalidation transport for canon's axes. Without it,
   * `status.invalidations` is `disabled`.
   */
  readonly invalidations?: InvalidationAdapter
}

/** Plain React has no framework control flow to rethrow. */
function rethrowNoControlFlow(): void {}

/**
 * Creates a framework-independent React hook that mounts one predicted root.
 * The root renders canon with every pending prediction applied, delivers
 * mutations through `send` one at a time in invocation order, and keeps canon
 * fresh through `refresh` and optional `invalidations`. Each call of the
 * returned hook mounts an independent root; share one root with a subtree
 * through {@link createPredictedRootContext}. While a delivery attempt is
 * unanswered, the root holds a React Action open for at most
 * {@link DELIVERY_WAIT_MS}. Unmounting the root settles every pending receipt.
 *
 * @param options Protocol, delivery, refresh, invalidation, and listener configuration.
 * @returns A hook exposing predicted state, mutation receipts, retry controls, and status.
 */
export function createPredictedRoot<
  const Protocol extends AnyProtocolDefinition,
>(options: PredictedRootOptions<Protocol>): PredictedRootHook<Protocol> {
  return createPredictedRootHook(options, rethrowNoControlFlow)
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
