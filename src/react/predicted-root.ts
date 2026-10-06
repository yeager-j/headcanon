"use client"

// The predicted-root hook. Not a package entry: `headcanon/react` and
// `headcanon/next/client` build their public factories on
// `createPredictedRootHook`, and only the Next binding supplies a
// control-flow classifier.
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
  type InvocationOf,
  type MutationContext,
  type MutationDefinition,
  type MutationErrorOf,
  type MutationInvocation,
  type MutationRefusalOf,
  type ProtocolDefinition,
  type ProtocolInvocation,
} from "../core/protocol"
import {
  covers,
  type AcceptedStamp,
  type AxisId,
  type Canon,
} from "../core/revisions"
import {
  createLedgerStore,
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

/** The mutation union a protocol registers. */
export type MutationOf<Protocol> =
  Protocol extends ProtocolDefinition<string, infer Mutations>
    ? Mutations[number]
    : never

// Both extractors re-alias the mutation union through `extends infer` so the
// conditional distributes per member. Matching the whole union against one
// `MutationDefinition<...>` fails inference as soon as a protocol registers
// mutations with different argument schemas (the schema sits in both co- and
// contravariant positions), silently collapsing State and Error to `never`.

/** The one state type every mutation of a protocol predicts. */
export type StateOf<Protocol> =
  MutationOf<Protocol> extends infer Mutation
    ? Mutation extends MutationDefinition<
        string,
        infer _Schema,
        infer State,
        infer _Error,
        infer _Refusal
      >
      ? State
      : never
    : never

/**
 * A protocol's internal ledger error union: predictor errors plus
 * per-mutation receipt refusals. The public mutate call correlates this union
 * back to the selected invocation.
 */
export type ErrorOf<Protocol> =
  | (MutationOf<Protocol> extends infer Mutation
      ? Mutation extends MutationDefinition<
          string,
          infer _Schema,
          infer _State,
          infer Error,
          infer _Refusal
        >
        ? Error
        : never
      : never)
  | MutationRefusalOf<MutationOf<Protocol>>

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

function mutationContext(mutationId: string): MutationContext {
  return Object.freeze({ mutationId })
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
 * Builds a predicted-root hook. `headcanon/react` passes a classifier that
 * classifies nothing; the Next binding passes `unstable_rethrow`.
 * @param options Protocol, delivery, refresh, invalidation, and listener configuration.
 * @param classifyDeliveryError Throws when a delivery error is framework control flow.
 * @returns The predicted-root hook.
 */
export function createPredictedRootHook<
  const Protocol extends ProtocolDefinition<
    string,
    readonly AnyMutationDefinition[]
  >,
>(
  options: PredictedRootOptions<Protocol>,
  classifyDeliveryError: (error: unknown) => void
): PredictedRootHook<Protocol> {
  type State = StateOf<Protocol>
  type Invocation = ProtocolInvocation<Protocol>
  type Error = ErrorOf<Protocol>

  const runtimeInvocation = (
    invocation: Invocation
  ): MutationInvocation<string, unknown> =>
    invocation as MutationInvocation<string, unknown>

  const predict = (
    state: State,
    envelope: MutationEnvelope<Invocation>
  ): Result<State, Error> => {
    const invocation = runtimeInvocation(envelope.invocation)
    const mutation = findMutation(
      options.protocol,
      invocation.name
    ) as unknown as RuntimeMutation<State, Error>
    return mutation.predict(
      state,
      invocation.args,
      mutationContext(envelope.mutationId)
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
      if (entry.conflicted) continue
      if (
        entry.delivery.kind === "accepted" &&
        covers(canon.revisions, entry.delivery.stamp.revisions)
      ) {
        continue
      }
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
      createLedgerStore<Invocation, Error>(options.send, classifyDeliveryError)
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
