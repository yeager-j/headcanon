"use client"

// The predicted-root hook. Not a package entry: `headcanon/react` and
// `headcanon/next/client` build their public factories on it.
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react"
import { err, ok, type Result } from "serializable-result"

import type { MutationEnvelope } from "../core/authority"
import type { InvalidationAdapter } from "../core/invalidation"
import {
  findMutation,
  type AnyMutationDefinition,
  type AnyProtocolDefinition,
  type InvocationOf,
  type MutationContext,
  type MutationErrorOf,
  type MutationInvocation,
  type MutationRefusalOf,
  type MutationState,
  type ProtocolInvocation,
  type ProtocolMutation,
} from "../core/protocol"
import type { AcceptedStamp, AxisId, Canon } from "../core/revisions"
import {
  createLedgerStore,
  isCanonized,
  queueHead,
  type LedgerEntry,
  type MutationLifecycleError,
  type MutationReceipt,
  type ReplayConflict,
} from "./ledger"
import {
  useIncorporation,
  type IncorporationStatus,
  type RefreshAdapter,
  type RefreshStallReason,
} from "./refresh"

/** The one state type every mutation of a protocol predicts. */
export type StateOf<Protocol> = MutationState<ProtocolMutation<Protocol>>

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
   * prediction's refusal: nothing was queued. `listeners` override the
   * factory's `mutationListeners` one stage at a time.
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

/** Protocol, delivery, refresh, and invalidation dependencies for a root factory. */
export interface PredictedRootOptions<Protocol extends AnyProtocolDefinition> {
  /** The protocol whose mutations the root predicts and delivers. */
  readonly protocol: Protocol
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
   * The current complete authoritative canon. Every new canon object re-folds
   * the pending predictions, so keep it referentially stable per
   * authoritative observation (RSC props and snapshot state are). A void
   * refresh carrier counts a canon as its delivery only when the state value
   * (by identity) or the revisions change; see {@link RefreshAdapter}.
   */
  readonly canon: Canon<State>
  /** Root-recovery observers scoped to this mounted aggregate. */
  readonly recoveryListeners?: PredictedRootRecoveryListeners<Invocation, Error>
}

/**
 * The public hook type returned by a predicted-root factory. Its protocol fixes
 * the canon state, invocation union, and correlated mutation error types.
 * @param input The current canon and optional per-mount recovery listeners.
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
  protocol: string,
  mutationId: string,
  invocation: Invocation
): MutationEnvelope<Invocation> {
  return Object.freeze({
    protocol,
    mutationId,
    invocation: structuredClone(invocation),
  })
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

  return function usePredictedRoot({ canon, recoveryListeners }) {
    const [store] = useState(() =>
      createLedgerStore<Invocation, Error>(options.send, rethrowControlFlow)
    )
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

    useEffect(() => {
      store.activate()
      return store.deactivate
    }, [store])

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
      store.deliverHead()
    }, [canon, projection, store])

    const mutate = useCallback(
      (
        invocation: Invocation,
        stageOverrides?: MutationStageListeners<Error>
      ): Result<MutationReceipt<Error>, Error> => {
        const stages = withDefaults(stageOverrides, options.mutationListeners)
        const envelope = freezeEnvelope(
          options.protocol.id,
          globalThis.crypto.randomUUID(),
          invocation
        )
        const predicted = predict(projection.value, envelope)
        if (!predicted.ok) {
          const result = err<Error>(predicted.error)
          stages.onPrediction?.(result)
          return result
        }

        const receipt = store.enqueue(envelope)
        if (stages.onAcceptance) {
          void receipt.accepted.then(stages.onAcceptance)
        }
        if (stages.onCanonization) {
          void receipt.canonized.then(stages.onCanonization)
        }
        const result = ok(receipt)
        stages.onPrediction?.(result)
        return result
      },
      [projection.value, store]
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
