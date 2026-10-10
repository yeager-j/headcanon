"use client"

// The predicted-root hook. Not a package entry: `headcanon/react` (through
// `createPredictedRoot`) and `headcanon/next/client` build their public
// factories on `createPredictedRootHook`.
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useInsertionEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import { err, ok, type Result } from "serializable-result"

import type { MutationEnvelope } from "../core/authority"
import {
  browserIsOffline,
  type InvalidationAdapter,
} from "../core/invalidation"
import {
  findMutation,
  type AnyMutationDefinition,
  type AnyProtocolDefinition,
  type InvocationOf,
  type MutationContext,
  type MutationErrorOf,
  type MutationInvocation,
  type MutationRefusalOf,
  type ProtocolInvocation,
  type ProtocolMutation,
  type ProtocolState,
} from "../core/protocol"
import type { AcceptedStamp, AxisId, Canon } from "../core/revisions"
import {
  createLedgerStore,
  isCanonized,
  queueHead,
  type FailureCounts,
  type LedgerEntry,
  type LedgerStore,
  type MutationLifecycleError,
  type MutationReceipt,
  type QueueRegistration,
  type ReplayConflict,
} from "./ledger"
import { createQueueStorage, type QueuePersistence } from "./persistence"
import {
  useIncorporation,
  type IncorporationStatus,
  type RefreshAdapter,
  type RefreshStallReason,
} from "./refresh"

/** The one state type every mutation of a protocol predicts. */
export type StateOf<Protocol> = ProtocolState<Protocol>

/**
 * A protocol's internal ledger error union: predictor errors plus
 * per-mutation receipt refusals. The public mutate call correlates this union
 * back to the selected invocation.
 */
export type ErrorOf<Protocol> =
  // `MutationErrorOf` reads one mutation. Re-aliasing the union through
  // `extends infer` makes the conditional distribute over each member.
  | (ProtocolMutation<Protocol> extends infer Mutation
      ? Mutation extends AnyMutationDefinition
        ? MutationErrorOf<Mutation>
        : never
      : never)
  // `MutationErrorOf` already includes each refusal. Naming the refusals again
  // lets generic code, such as a sender, return one before `Protocol` is known.
  | MutationRefusalOf<ProtocolMutation<Protocol>>

/** The mutation an acceptance or canonization listener reports. */
export interface StagedMutation {
  /** The mutation ID, the same as its receipt's `id`. */
  readonly id: string
  /**
   * `true` when no `mutate` call of this root holds the mutation's receipt:
   * the root restored it from its `persistence` after a page load, or took
   * it over from an earlier root of the same queue.
   */
  readonly restored: boolean
}

/** Observers for the three mutation stages represented by a receipt. */
export interface MutationStageListeners<Error> {
  /**
   * Called immediately with the local prediction result. Not called for a
   * restored mutation: another page or root made its prediction.
   */
  readonly onPrediction?: (
    result: Result<MutationReceipt<Error>, Error>
  ) => void
  /** Called when the authority accepts or refuses the mutation. */
  readonly onAcceptance?: (
    result: Result<AcceptedStamp, MutationLifecycleError<Error>>,
    mutation: StagedMutation
  ) => void
  /** Called when acceptance is incorporated into canon, or can no longer be. */
  readonly onCanonization?: (
    result: Result<void, MutationLifecycleError<Error>>,
    mutation: StagedMutation
  ) => void
}

/** State and controls exposed by a mounted optimistic predicted root. */
export interface PredictedRoot<State, Invocation, Error> {
  /**
   * Canon's state with every pending prediction applied in invocation order.
   * An accepted prediction keeps applying until canon covers its stamp.
   */
  readonly value: State
  /**
   * Predicts `invocation` over `value` and, when the prediction succeeds,
   * queues it for delivery and returns its receipt. An `err` is the local
   * prediction's refusal: nothing was queued, and the root refreshes canon.
   * `listeners` override the root's `mutationListeners` and then the
   * factory's, one stage at a time.
   */
  readonly mutate: (
    invocation: Invocation,
    listeners?: MutationStageListeners<Error>
  ) => Result<MutationReceipt<Error>, Error>
  /**
   * Redelivers an `uncertain` queue head with the same envelope and mutation
   * ID, and a fresh budget of automatic redeliveries. Does nothing unless
   * `status.delivery` is `uncertain`.
   */
  readonly retryDelivery: () => void
  /**
   * Refreshes now with a fresh attempt budget when canon does not meet the
   * root's requirements, such as after a stall.
   */
  readonly retryRefresh: () => void
  /** Delivery status, plus freshness and invalidation status of the mounted canon. */
  readonly status: {
    /** Mutations not yet settled, including accepted ones waiting for canon to cover them. */
    readonly pending: number
    /**
     * `idle` when no mutation awaits acceptance, even while `pending` is above
     * zero. `uncertain` when the queue head's outcome is unknown: `send` threw
     * an ordinary error, gave no answer within `DELIVERY_WAIT_MS`, or used up
     * its automatic redeliveries. The queue then waits for `retryDelivery()`
     * or a late answer. `sending` otherwise, including a queued head and
     * redelivery backoff.
     */
    readonly delivery: "idle" | "sending" | "uncertain"
  } & IncorporationStatus
  /** The most recent replay conflicts (up to 50), oldest first. */
  readonly conflicts: readonly ReplayConflict<Invocation, Error>[]
}

type MutationForInvocation<Protocol, Invocation> =
  ProtocolMutation<Protocol> extends infer Mutation
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
export type ProtocolPredictedRoot<Protocol extends AnyProtocolDefinition> =
  Omit<
    PredictedRoot<
      StateOf<Protocol>,
      ProtocolInvocation<Protocol>,
      ErrorOf<Protocol>
    >,
    "mutate"
  > & {
    readonly mutate: <Invocation extends ProtocolInvocation<Protocol>>(
      invocation: Invocation,
      listeners?: MutationStageListeners<
        ErrorForInvocation<Protocol, Invocation>
      >
    ) => Result<
      MutationReceipt<ErrorForInvocation<Protocol, Invocation>>,
      ErrorForInvocation<Protocol, Invocation>
    >
  }

/** One store for every root, or a store chosen per root from its first canon. */
type PersistenceOption<State> =
  | QueuePersistence
  | ((canon: Canon<State>) => QueuePersistence | undefined)

/** Protocol, delivery, refresh, and invalidation dependencies for a root factory. */
export interface PredictedRootOptions<Protocol extends AnyProtocolDefinition> {
  /** The protocol whose mutations the root predicts and delivers. */
  readonly protocol: Protocol
  /**
   * Returns the receipt scope of the actor that `canon` belongs to: the value
   * the authority's `scope(actor)` returns for that actor, such as a user ID.
   * `mutate` calls it with the canon the root renders, and the mutation's
   * envelope keeps that scope through every redelivery and page load. The
   * action denies an envelope whose scope is not the delivering actor's, so
   * a mutation queued before a sign-out never runs as the next actor.
   * @example
   * ```ts
   * scope: (canon) => canon.value.ownerId
   * ```
   */
  readonly scope: (canon: Canon<StateOf<Protocol>>) => string
  /**
   * Delivers one envelope to the authority and resolves with its accepted
   * stamp or domain refusal. An ordinary throw means delivery is uncertain
   * (the commit may exist). Throw {@link RetryableDeliveryError} instead when
   * the authority verifiably stored no receipt and the same envelope should
   * simply be redelivered (exhausted contention), and
   * {@link TerminalDeliveryError} when the authority's answer is final but is
   * not a domain refusal (a denial, or an executor refusal of the envelope).
   */
  readonly send: (
    envelope: MutationEnvelope<ProtocolInvocation<Protocol>>
  ) => Promise<Result<AcceptedStamp, ErrorOf<Protocol>>>
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
  /**
   * Default stage observers used when neither a mutate call nor the mounted
   * root supplies a stage. They also observe every mutation restored from
   * `persistence`.
   */
  readonly mutationListeners?: MutationStageListeners<ErrorOf<Protocol>>
  /**
   * Keeps the unsettled queue across a page load, such as
   * `sessionStoragePersistence(key)`. The root stores each mutation when it
   * is queued and removes it when it is accepted or fails. On mount, the root
   * restores the stored mutations ahead of new ones and delivers them again
   * under their original mutation IDs.
   *
   * The queue outlives its root: after unmount, delivery continues in order
   * and stops at an uncertain mutation. A root of this factory that mounts
   * with the same key continues the same queue. Without `persistence`, the
   * queue lives only in memory, and unmount sends the mutations that were
   * never sent.
   *
   * Each mounted root needs its own key, and a key belongs to one factory. When one factory mounts a root
   * per record, pass a function: each root calls it once, with its first
   * canon, and keeps the result. Return `undefined` to keep that root's
   * queue in memory.
   * @example
   * ```ts
   * persistence: (canon) =>
   *   sessionStoragePersistence(
   *     `notes-queue:${canon.value.ownerId}:${canon.value.id}`
   *   )
   * ```
   */
  readonly persistence?: PersistenceOption<StateOf<Protocol>>
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
   * The current complete authoritative canon. Every new canon object re-folds
   * the pending predictions, so keep it referentially stable per
   * authoritative observation (RSC props and snapshot state are). A void
   * refresh carrier counts a canon as its delivery only when the state value
   * (by identity) or the revisions change; see {@link RefreshAdapter}.
   */
  readonly canon: Canon<State>
  /** Root-recovery observers scoped to this mounted aggregate. */
  readonly recoveryListeners?: PredictedRootRecoveryListeners<Invocation, Error>
  /**
   * Stage observers scoped to this mounted aggregate. Each stage replaces the
   * factory's, and a mutate call's own stage replaces both for that call.
   * They also observe every mutation restored from `persistence`. A stage is
   * read when it runs, so a receipt that settles after a re-render reports to
   * that render's listener.
   */
  readonly mutationListeners?: MutationStageListeners<Error>
}

/**
 * The public hook type returned by a predicted-root factory. Its protocol fixes
 * the canon state, invocation union, and correlated mutation error types.
 * @param input The current canon and optional per-mount listeners.
 * @returns Protocol-specialized predicted root state and controls.
 */
export type PredictedRootHook<Protocol extends AnyProtocolDefinition> = (
  input: PredictedRootInput<
    StateOf<Protocol>,
    ProtocolInvocation<Protocol>,
    ErrorOf<Protocol>
  >
) => ProtocolPredictedRoot<Protocol>

/** Delivery recovery controls supplied while the queue head is uncertain. */
export interface DeliveryRecovery {
  /** Redelivers the uncertain queue head; see {@link PredictedRoot.retryDelivery}. */
  readonly retry: () => void
}

/** Canon recovery facts supplied while authoritative incorporation is stalled. */
export interface FreshnessRecovery {
  /** Refreshes now with a fresh attempt budget; see {@link PredictedRoot.retryRefresh}. */
  readonly retry: () => void
  /** Why the refresh attempts ran out. */
  readonly reason: RefreshStallReason
  /** Required axes the mounted canon does not carry at all. */
  readonly missingAxes: readonly AxisId[]
}

/** Application-owned listeners for a predicted root's degraded states and conflicts. */
export interface PredictedRootRecoveryListeners<Invocation, Error> {
  /**
   * Called when delivery becomes `uncertain`. A returned cleanup runs when
   * delivery recovers or the root unmounts.
   */
  readonly onDeliveryUncertain?: (
    recovery: DeliveryRecovery
  ) => void | (() => void)
  /**
   * Called when freshness becomes `stalled`. A returned cleanup runs when
   * freshness recovers or the root unmounts.
   */
  readonly onFreshnessStalled?: (
    recovery: FreshnessRecovery
  ) => void | (() => void)
  /**
   * Called once per mutation ID, during the mounted lifetime, when newer
   * canon refuses a pending prediction.
   */
  readonly onConflict?: (conflict: ReplayConflict<Invocation, Error>) => void
}

interface RuntimeMutation<State, Error> {
  readonly predict: (
    state: State,
    args: unknown,
    context: MutationContext
  ) => Result<State, Error>
}

interface ReplayRefusal<Error> {
  readonly mutationId: string
  readonly error: Error
}

interface Projection<State, Error> {
  readonly value: State
  readonly refusals: readonly ReplayRefusal<Error>[]
}

function freezeEnvelope<Invocation>(
  envelope: MutationEnvelope<Invocation>
): MutationEnvelope<Invocation> {
  return Object.freeze({
    ...envelope,
    invocation: structuredClone(envelope.invocation),
  })
}

/** A queue in memory ends with its root, so no later root looks it up. */
const UNREGISTERED_QUEUE: QueueRegistration = {
  register: () => undefined,
  release: () => undefined,
}

/** The store one root uses: the option itself, or its answer for `canon`. */
function persistenceFor<State>(
  option: PersistenceOption<State> | undefined,
  canon: Canon<State>
): QueuePersistence | undefined {
  return typeof option === "function" ? option(canon) : option
}

/**
 * Calls the acceptance and canonization listeners when `receipt` settles,
 * reading each from `stages` at that moment.
 */
function observeStages<Error>(
  receipt: MutationReceipt<Error>,
  stages: () => MutationStageListeners<Error>,
  restored: boolean
): void {
  const mutation: StagedMutation = { id: receipt.id, restored }

  void receipt.accepted.then((result) =>
    stages().onAcceptance?.(result, mutation)
  )
  void receipt.canonized.then((result) =>
    stages().onCanonization?.(result, mutation)
  )
}

/**
 * Whether a failure of `kind` shows that the server's state may differ from
 * the canon the prediction ran over, so the root refreshes canon.
 */
function failureRefreshesCanon(
  kind: MutationLifecycleError<unknown>["kind"]
): boolean {
  switch (kind) {
    case "domain":
    case "denied":
    case "undeliverable":
      return true
    // `stale-client`: a router refresh would load the new build, and the
    // application owns that reload. `replay-refused`: newer canon already
    // refused the prediction. `delivery-cancelled`: the framework handles
    // its control flow, such as a redirect. `root-unmounted`: no root
    // remains to refresh.
    case "stale-client":
    case "replay-refused":
    case "delivery-cancelled":
    case "root-unmounted":
      return false
  }
}

/** How many of the counted failures refresh canon. */
function countRefreshingFailures(failures: FailureCounts): number {
  let count = 0
  for (const [kind, occurrences] of Object.entries(failures)) {
    if (failureRefreshesCanon(kind as keyof FailureCounts)) {
      count += occurrences ?? 0
    }
  }
  return count
}

/**
 * Returns the gap signal for a local refusal. While the browser reports it is
 * offline, the signal waits for the browser's `online` event, because a router
 * refresh that fails loads the full page. Signals held while offline become
 * one, and none is sent once the root unmounts.
 */
function useOnlineGapSignal(signalGap: () => void): () => void {
  const heldWhileOffline = useRef(false)

  useEffect(() => {
    if (typeof window === "undefined") return

    const signalHeld = () => {
      if (!heldWhileOffline.current || browserIsOffline()) return

      heldWhileOffline.current = false
      signalGap()
    }

    // React Activity may have hidden the root, and removed the listener,
    // while the browser came back online.
    signalHeld()
    window.addEventListener("online", signalHeld)
    return () => window.removeEventListener("online", signalHeld)
  }, [signalGap])

  return useCallback(() => {
    if (browserIsOffline()) heldWhileOffline.current = true
    else signalGap()
  }, [signalGap])
}

/**
 * Merges per-call or per-mount listeners over factory defaults, one stage or
 * condition at a time.
 */
function withDefaults<Listeners extends object>(
  overrides: Listeners | undefined,
  defaults: Listeners | undefined
): Partial<Listeners> {
  const merged: Partial<Listeners> = { ...defaults }
  if (!overrides) return merged
  for (const key of Object.keys(overrides) as (keyof Listeners)[]) {
    if (overrides[key] !== undefined) merged[key] = overrides[key]
  }
  return merged
}

type RecoverySource = Pick<
  PredictedRoot<unknown, unknown, unknown>,
  "status" | "retryDelivery" | "retryRefresh"
>

function useDegradedStateListeners(
  root: RecoverySource,
  listeners: Pick<
    PredictedRootRecoveryListeners<unknown, unknown>,
    "onDeliveryUncertain" | "onFreshnessStalled"
  >
): void {
  const enterUncertainDelivery = useEffectEvent(() => {
    const recovery: DeliveryRecovery = { retry: root.retryDelivery }
    return listeners.onDeliveryUncertain?.(recovery)
  })
  const handlesUncertainDelivery = listeners.onDeliveryUncertain !== undefined
  useEffect(() => {
    if (!handlesUncertainDelivery || root.status.delivery !== "uncertain") {
      return
    }
    return enterUncertainDelivery()
  }, [handlesUncertainDelivery, root.retryDelivery, root.status.delivery])

  const enterStalledFreshness = useEffectEvent(() => {
    const status = root.status
    if (status.freshness !== "stalled") return
    const recovery: FreshnessRecovery = {
      retry: root.retryRefresh,
      reason: status.stallReason,
      missingAxes: status.missingAxes,
    }
    return listeners.onFreshnessStalled?.(recovery)
  })
  const handlesStalledFreshness = listeners.onFreshnessStalled !== undefined
  useEffect(() => {
    if (!handlesStalledFreshness || root.status.freshness !== "stalled") {
      return
    }
    return enterStalledFreshness()
  }, [handlesStalledFreshness, root.retryRefresh, root.status.freshness])
}

/**
 * Builds a predicted-root hook.
 * @param options Protocol, delivery, refresh, invalidation, and listener configuration.
 * @param rethrowControlFlow Rethrows `error` when it is framework control
 *   flow that must reach the framework; returns otherwise.
 * @returns The predicted-root hook.
 */
export function createPredictedRootHook<
  const Protocol extends AnyProtocolDefinition,
>(
  options: PredictedRootOptions<Protocol>,
  rethrowControlFlow: (error: unknown) => void
): PredictedRootHook<Protocol> {
  type State = StateOf<Protocol>
  type Invocation = ProtocolInvocation<Protocol>
  type Error = ErrorOf<Protocol>

  const predict = (
    state: State,
    envelope: MutationEnvelope<Invocation>
  ): Result<State, Error> => {
    const invocation = envelope.invocation as MutationInvocation<
      string,
      unknown
    >
    const mutation = findMutation(
      options.protocol,
      invocation.name
    ) as unknown as RuntimeMutation<State, Error>
    return mutation.predict(
      state,
      invocation.args,
      Object.freeze({ mutationId: envelope.mutationId })
    )
  }

  /**
   * The rendered value: every live prediction folded over canon in
   * invocation order. An accepted mutation stays predicted until this canon
   * covers its stamp — however long the carrier takes — and then is
   * identity, so the render that delivers covering canon never applies it
   * twice.
   */
  const project = (
    canon: Canon<State>,
    entries: readonly LedgerEntry<Invocation>[]
  ): Projection<State, Error> => {
    let value = canon.value
    const refusals: ReplayRefusal<Error>[] = []
    for (const entry of entries) {
      if (entry.conflicted || isCanonized(entry, canon.revisions)) continue
      const predicted = predict(value, entry.envelope)
      if (predicted.ok) value = predicted.value
      else
        refusals.push({
          mutationId: entry.envelope.mutationId,
          error: predicted.error,
        })
    }
    return { value, refusals }
  }

  /** This factory's persisted queues by key, while they outlive a root. */
  const queues = new Map<string, LedgerStore<Invocation, Error>>()

  /**
   * The ledger of the queue `canon` selects: the one an earlier root of this
   * factory left delivering under the same key, or a new one. A new ledger
   * joins `queues` as it is created, so a `mutate` that outlived an earlier
   * root of the key finds it. A server render adds nothing: no later root
   * of that request could continue it.
   */
  const ledgerFor = (canon: Canon<State>): LedgerStore<Invocation, Error> => {
    const persistence = persistenceFor(options.persistence, canon)
    const storage = createQueueStorage<Invocation>(
      persistence,
      options.protocol
    )
    if (!persistence) {
      return createLedgerStore(
        options.send,
        rethrowControlFlow,
        storage,
        UNREGISTERED_QUEUE
      )
    }

    const { key } = persistence
    const continued = queues.get(key)
    if (continued) return continued

    const store: LedgerStore<Invocation, Error> = createLedgerStore(
      options.send,
      rethrowControlFlow,
      storage,
      {
        register() {
          if (!queues.has(key)) queues.set(key, store)
        },
        release() {
          if (queues.get(key) === store) queues.delete(key)
        },
      }
    )
    if (typeof window !== "undefined") queues.set(key, store)
    return store
  }

  /** The ledger now delivering `store`'s queue: a later root may have replaced it. */
  const continuedLedger = (
    store: LedgerStore<Invocation, Error>
  ): LedgerStore<Invocation, Error> =>
    (store.key !== undefined && queues.get(store.key)) || store

  return function usePredictedRoot({
    canon,
    recoveryListeners,
    mutationListeners,
  }) {
    const [store] = useState(() => ledgerFor(canon))
    // Identifies this root to the ledger, which may outlive it.
    const [observerToken] = useState(() => ({}))
    const ledger = useSyncExternalStore(
      store.subscribe,
      store.getSnapshot,
      store.getSnapshot
    )
    const useRefresh = options.refresh
    const refresh = useRefresh()
    // The ledger is the one authority for accepted stamps; incorporation
    // follows it rather than keeping its own.
    const incorporation = useIncorporation(
      canon,
      refresh,
      options.invalidations,
      store
    )
    const projection = useMemo(
      () => project(canon, ledger.entries),
      [canon, ledger.entries]
    )
    const listeners = withDefaults(recoveryListeners, options.recoveryListeners)

    // Receipts settle after the render that observed them, so their stages
    // are read from the latest committed listeners when they run. An
    // insertion effect runs before every layout effect, so a descendant that
    // calls `mutate` from its own layout effect reads this commit's listeners.
    const latestMutationListeners = useRef(mutationListeners)
    useInsertionEffect(() => {
      latestMutationListeners.current = mutationListeners
    }, [mutationListeners])
    const mountedStages = useCallback(
      () =>
        withDefaults(
          latestMutationListeners.current,
          options.mutationListeners
        ),
      []
    )

    // Restores in an effect or in `mutate`, never during render, so the
    // hydration render matches the server's. `mutate` restores too because a
    // child's mount effect runs before this root's.
    const restoreQueue = useCallback((): void => {
      for (const receipt of store.restore(observerToken)) {
        observeStages(receipt, mountedStages, true)
      }
    }, [mountedStages, observerToken, store])

    // Follows the ledger's failure counts rather than receipts, so a
    // mutation whose receipt this root does not hold, such as one queued by
    // an earlier root's `mutate` after it unmounted, still refreshes this
    // root. Counting from the first render also covers a failure that
    // settles before this effect subscribes.
    const { signalGap } = incorporation
    const signalRefusalGap = useOnlineGapSignal(signalGap)
    const signalledFailures = useRef(countRefreshingFailures(ledger.failures))
    useEffect(() => {
      const signalNewFailures = () => {
        const count = countRefreshingFailures(store.getSnapshot().failures)
        if (count <= signalledFailures.current) return

        signalledFailures.current = count
        signalGap()
      }

      signalNewFailures()
      return store.subscribe(signalNewFailures)
    }, [signalGap, store])

    // Set from the effect's cleanup until its next setup: unmount, or React
    // Activity hiding the root. A `mutate` held past it, such as a debounced
    // save, no longer restores: it must not make the root observe again.
    const observationDeactivated = useRef(false)
    useEffect(() => {
      observationDeactivated.current = false
      restoreQueue()
      store.activate(observerToken)
      return () => {
        observationDeactivated.current = true
        store.deactivate(observerToken)
      }
    }, [observerToken, restoreQueue, store])

    // Reconcile this render's projection, then deliver. Refusals first, so a
    // jossed envelope that never left is retracted before it could be sent.
    const surfaceConflict = useEffectEvent(
      (conflict: ReplayConflict<Invocation, Error>) =>
        listeners.onConflict?.(conflict)
    )
    useEffect(() => {
      for (const refusal of projection.refusals) {
        const conflict = store.recordConflict(refusal.mutationId, refusal.error)
        if (conflict) surfaceConflict(conflict)
      }
      store.canonize(canon.revisions)
      store.deliverHead(ledger.entries)
    }, [canon, ledger.entries, projection, store])

    const mutate = useCallback(
      (
        invocation: Invocation,
        stageOverrides?: MutationStageListeners<Error>
      ): Result<MutationReceipt<Error>, Error> => {
        if (!observationDeactivated.current) restoreQueue()
        // Until a render includes the restored entries, every call predicts
        // over them and this render's entries, so calls in one event still
        // check against one value.
        const unrenderedRestore =
          ledger.restoredEntries.length === 0
            ? store.getSnapshot().restoredEntries
            : []
        const current =
          unrenderedRestore.length === 0
            ? projection.value
            : project(canon, [...unrenderedRestore, ...ledger.entries]).value
        const stages = () => withDefaults(stageOverrides, mountedStages())
        const envelope = freezeEnvelope({
          protocol: options.protocol.id,
          scope: options.scope(canon),
          mutationId: globalThis.crypto.randomUUID(),
          createdAt: Date.now(),
          invocation,
        })
        const predicted = predict(current, envelope)
        if (!predicted.ok) {
          // The refusal may come from canon that is behind the server. A
          // root that no longer observes has no canon to refresh.
          if (!observationDeactivated.current) signalRefusalGap()
          const result = err<Error>(predicted.error)
          stages().onPrediction?.(result)
          return result
        }

        const queue = observationDeactivated.current
          ? continuedLedger(store)
          : store
        const receipt = queue.enqueue(envelope)
        observeStages(receipt, stages, false)
        const result = ok(receipt)
        stages().onPrediction?.(result)
        return result
      },
      [
        canon,
        ledger,
        mountedStages,
        projection.value,
        restoreQueue,
        signalRefusalGap,
        store,
      ]
    )

    const head = queueHead(ledger.entries)
    const root: ProtocolPredictedRoot<Protocol> = {
      value: projection.value,
      mutate: mutate as ProtocolPredictedRoot<Protocol>["mutate"],
      retryDelivery: store.retryDelivery,
      retryRefresh: incorporation.retryRefresh,
      status: {
        pending: ledger.entries.length,
        delivery:
          head === undefined
            ? "idle"
            : head.delivery.kind === "uncertain"
              ? "uncertain"
              : "sending",
        ...incorporation.status,
      },
      conflicts: ledger.conflicts,
    }
    useDegradedStateListeners(root, listeners)
    return root
  }
}

/** Plain React has no framework control flow to rethrow. */
function rethrowNoControlFlow(): void {}

/**
 * Creates a framework-independent React hook that mounts one predicted root.
 * The root renders canon with every pending prediction applied, delivers
 * mutations through `send` one at a time in invocation order, and keeps canon
 * fresh through `refresh` and optional `invalidations`. Each call of the
 * returned hook mounts an independent root; share one root with a subtree
 * through `createPredictedRootContext`. While a delivery attempt is
 * unanswered, the root holds a React Action open for at most
 * `DELIVERY_WAIT_MS`. Unmounting the root settles every pending receipt; with
 * `persistence`, delivery continues after unmount, and a page load delivers
 * the stored mutations again.
 *
 * @param options Protocol, delivery, refresh, invalidation, and listener configuration.
 * @returns A hook exposing predicted state, mutation receipts, retry controls, and status.
 */
export function createPredictedRoot<
  const Protocol extends AnyProtocolDefinition,
>(options: PredictedRootOptions<Protocol>): PredictedRootHook<Protocol> {
  return createPredictedRootHook(options, rethrowNoControlFlow)
}
