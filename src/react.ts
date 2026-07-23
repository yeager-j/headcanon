"use client"

import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useOptimistic,
  useReducer,
  useRef,
  useState,
} from "react"

import { err, ok, type Result } from "@workspace/result"

import type { MutationEnvelope } from "./authority"
import type {
  AnyMutationDefinition,
  InvocationOf,
  MutationContext,
  MutationDefinition,
  MutationErrorOf,
  MutationInvocation,
  MutationRefusalOf,
  ProtocolDefinition,
  ProtocolInvocation,
} from "./protocol"
import {
  useIncorporation,
  type IncorporationStatus,
  type InvalidationAdapter,
  type RefreshAdapter,
} from "./refresh"
import {
  covers,
  type AcceptedStamp,
  type Canon,
  type RevisionVector,
} from "./revisions"

/** Terminal lifecycle failures surfaced by a predicted root's receipts. */
export type MutationLifecycleError<Error> =
  | { readonly kind: "domain"; readonly error: Error }
  | { readonly kind: "replay-refused"; readonly error: Error }
  | { readonly kind: "delivery-cancelled" }
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
    invocation: Invocation
  ) => Result<MutationReceipt<Error>, Error>
  readonly retryDelivery: () => void
  readonly retryRefresh: () => void
  readonly status: {
    readonly pending: number
    readonly delivery: "idle" | "sending" | "uncertain"
  } & IncorporationStatus
  readonly conflicts: readonly ReplayConflict<Invocation, Error>[]
}

/** Read-only state and lifecycle controls exposed by an observed root. */
export interface ObservedRoot<State> {
  readonly value: State
  readonly retryRefresh: () => void
  readonly status: IncorporationStatus
}

type MutationOf<Protocol> =
  Protocol extends ProtocolDefinition<string, infer Mutations>
    ? Mutations[number]
    : never

// Both extractors re-alias the mutation union through `extends infer` so the
// conditional distributes per member. Matching the whole union against one
// `MutationDefinition<...>` fails inference as soon as a protocol registers
// mutations with different argument schemas (the schema sits in both co- and
// contravariant positions), silently collapsing State and Error to `never`.

type StateOf<Protocol> =
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

// A protocol's internal ledger error union: predictor errors plus per-mutation
// receipt refusals. The public mutate call below correlates this union back to
// the selected invocation.
type ErrorOf<Protocol> =
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
    invocation: Invocation
  ) => Result<
    MutationReceipt<ErrorForInvocation<Protocol, Invocation>>,
    ErrorForInvocation<Protocol, Invocation>
  >
}

/**
 * The `send` adapter throws this when the authority reported **no terminal
 * receipt** but redelivery of the same envelope is safe and expected —
 * exhausted internal contention is the canonical case. Unlike an ordinary
 * throw (uncertain delivery: the commit may exist), this is a known-clean
 * miss: the package keeps the prediction and the envelope, redelivers the same
 * mutation ID on a bounded backoff, and only after the redelivery budget is
 * spent surfaces `delivery: "uncertain"` for the caller's manual retry.
 */
export class RetryableDeliveryError extends Error {
  constructor(reason?: string) {
    super(reason ?? "delivery should be retried")
    this.name = "RetryableDeliveryError"
  }
}

/** Redelivery backoff for {@link RetryableDeliveryError} — bounded so persistent
 *  contention degrades to an honest uncertain state instead of hammering. */
const DELIVERY_RETRY_DELAYS_MS = [300, 1000, 3000] as const

/** Protocol, delivery, refresh, and invalidation dependencies for a root factory. */
export interface PredictedRootOptions<
  Protocol extends ProtocolDefinition<string, readonly AnyMutationDefinition[]>,
> {
  readonly protocol: Protocol
  /**
   * Delivers one envelope after framework control-flow throws have been
   * classified. An ordinary throw at this seam means delivery is uncertain
   * (the commit may exist); throw {@link RetryableDeliveryError} instead when
   * the authority verifiably stored no receipt and the same envelope should
   * simply be redelivered (exhausted contention).
   */
  readonly send: (
    envelope: MutationEnvelope<ProtocolInvocation<Protocol>>
  ) => Promise<Result<AcceptedStamp, ErrorOf<Protocol>>>
  readonly refresh: () => RefreshAdapter
  readonly invalidations?: InvalidationAdapter
}

/** Latest complete authoritative canon supplied to a mounted root. */
export interface PredictedRootInput<State> {
  /**
   * The current complete authoritative canon. Must be **referentially stable
   * per authoritative observation** — RSC props and snapshot state naturally
   * are. A canon object rebuilt on every render re-bases `useOptimistic`
   * each pass, and while an optimistic action is open that rebase renders a
   * fresh base again: an unbounded render loop.
   */
  readonly canon: Canon<State>
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
  input: PredictedRootInput<StateOf<Protocol>>
) => ProtocolPredictedRoot<Protocol>

/** Refresh and optional invalidation dependencies for an observed root. */
export interface ObservedRootOptions {
  readonly refresh: () => RefreshAdapter
  readonly invalidations?: InvalidationAdapter
}

interface Deferred<Value> {
  readonly promise: Promise<Value>
  readonly settled: boolean
  reject(reason: unknown): void
  resolve(value: Value): void
}

function createDeferred<Value>(): Deferred<Value> {
  let resolvePromise: (value: Value) => void = () => undefined
  let rejectPromise: (reason: unknown) => void = () => undefined
  let settled = false
  const promise = new Promise<Value>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })

  return {
    promise,
    get settled() {
      return settled
    },
    reject(reason) {
      if (settled) return
      settled = true
      rejectPromise(reason)
    },
    resolve(value) {
      if (settled) return
      settled = true
      resolvePromise(value)
    },
  }
}

type DeliveryState =
  | "queued"
  | "sending"
  | "retry-scheduled"
  | "uncertain"
  | "accepted"
  | "rejected"
  | "cancelled"

interface LedgerEntry<Invocation, Error> {
  readonly envelope: MutationEnvelope<Invocation>
  readonly accepted: Deferred<
    Result<AcceptedStamp, MutationLifecycleError<Error>>
  >
  readonly canonized: Deferred<Result<void, MutationLifecycleError<Error>>>
  /**
   * The hold keeping this entry's optimistic Action open. Re-armed by
   * {@link openDeliveryAction} when a paused queue resumes, so the field is
   * mutable; every resolve/reject must read it at settlement time.
   *
   * UNN-682: an Action may be held only while delivery is actively
   * progressing (queued behind a progressing head, sending, or inside the
   * bounded redelivery backoff). React entangles ALL transition-lane work —
   * Server Action RSC payloads, `router.refresh()`, navigations — with
   * pending Actions and commits none of it until every Action settles, so an
   * Action held for an unbounded wait (canonization, manual retry) deadlocks
   * canon delivery and freezes navigation.
   */
  releaseAction: Deferred<void>
  delivery: DeliveryState
  /** Automatic redeliveries consumed after {@link RetryableDeliveryError}s. */
  retryAttempts: number
  acceptedStamp?: AcceptedStamp
  replayRefusal?: Error
}

interface OptimisticUpdate<Invocation> {
  readonly envelope: MutationEnvelope<Invocation>
}

interface ReplayRefusal<Error> {
  readonly mutationId: string
  readonly error: Error
}

interface ReplayFrame<State, Error> {
  readonly value: State
  readonly revisions: RevisionVector
  readonly acceptedById: ReadonlyMap<string, AcceptedStamp>
  readonly refusedIds: ReadonlySet<string>
  /**
   * Mutations whose queue is paused on an unbounded-uncertain head. Their
   * predictions reduce to identity — the paused root renders canon truth —
   * while the ledger keeps their envelopes for resume (UNN-682).
   */
  readonly pausedIds: ReadonlySet<string>
  readonly replayedMutationIds: readonly string[]
  readonly refusals: readonly ReplayRefusal<Error>[]
}

interface RuntimeMutation<State, Error> {
  readonly predict: (
    state: State,
    args: unknown,
    context: MutationContext
  ) => Result<State, Error>
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

function noop(): void {}

function removeFromQueue(queue: string[], mutationId: string): void {
  const index = queue.indexOf(mutationId)
  if (index >= 0) queue.splice(index, 1)
}

/**
 * Creates a framework-independent React predicted-root hook.
 *
 * The returned hook keeps the latest complete `Canon` as the authoritative
 * base and folds pending invocations over it with React's optimistic state
 * mechanism. A successful local prediction returns a receipt with independent
 * `accepted` and `canonized` promises: acceptance means the authority committed
 * an `AcceptedStamp`, while canonization waits until this root's canon covers
 * that stamp. Delivery is serialized in invocation order, uncertain envelopes
 * retain their original mutation ID for retry, and replay-refused predictions
 * are reported as conflicts rather than silently disappearing. Callers own the
 * refresh carrier and optional invalidation transport; the root owns
 * subscription cleanup and pending-receipt settlement on unmount.
 *
 * @param options Protocol, delivery, refresh, and optional invalidation dependencies.
 * @returns A hook exposing predicted state, mutation receipts, retry controls, and status.
 */
export function createPredictedRoot<
  const Protocol extends ProtocolDefinition<
    string,
    readonly AnyMutationDefinition[]
  >,
>(options: PredictedRootOptions<Protocol>) {
  return createPredictedRootWithDeliveryErrorClassifier(
    options,
    () => undefined
  )
}

/**
 * Builds a predicted-root hook with a framework-specific control-flow classifier.
 * @internal Framework bindings use this to preserve control-flow throws.
 * @param options Protocol, delivery, refresh, and invalidation dependencies.
 * @param classifyDeliveryError Classifies framework control-flow exceptions.
 * @returns A hook that mounts the configured predicted root.
 */
export function createPredictedRootWithDeliveryErrorClassifier<
  const Protocol extends ProtocolDefinition<
    string,
    readonly AnyMutationDefinition[]
  >,
>(
  options: PredictedRootOptions<Protocol>,
  classifyDeliveryError: (error: unknown) => void
) {
  type State = StateOf<Protocol>
  type Invocation = ProtocolInvocation<Protocol>
  type Error = ErrorOf<Protocol>

  const runtimeInvocation = (
    invocation: Invocation
  ): MutationInvocation<string, unknown> =>
    invocation as MutationInvocation<string, unknown>

  const mutationFor = (invocation: Invocation): RuntimeMutation<State, Error> =>
    options.protocol.mutationsByName[
      runtimeInvocation(invocation).name
    ] as unknown as RuntimeMutation<State, Error>

  return function usePredictedRoot({
    canon,
  }: PredictedRootInput<State>): ProtocolPredictedRoot<Protocol> {
    const ledgerRef = useRef(new Map<string, LedgerEntry<Invocation, Error>>())
    const queueRef = useRef<string[]>([])
    const conflictsRef = useRef<ReplayConflict<Invocation, Error>[]>([])
    const activeTokenRef = useRef<object | null>(null)
    const [acceptedById, setAcceptedById] = useState<
      ReadonlyMap<string, AcceptedStamp>
    >(() => new Map())
    const [refusedIds, setRefusedIds] = useState<ReadonlySet<string>>(
      () => new Set()
    )
    const [pausedIds, setPausedIds] = useState<ReadonlySet<string>>(
      () => new Set()
    )
    const [, renderCoordinator] = useReducer(
      (revision: number) => revision + 1,
      0
    )
    const useRefresh = options.refresh
    const refresh = useRefresh()
    const incorporation = useIncorporation(
      canon,
      refresh,
      options.invalidations
    )
    const recordAcceptance = incorporation.recordAcceptance
    const removeAcceptance = incorporation.removeAcceptance

    const releaseAction = useCallback(
      (entry: LedgerEntry<Invocation, Error>) => entry.releaseAction.resolve(),
      []
    )

    /**
     * A queue pausing on an unbounded-uncertain head stops progressing, so no
     * entry may keep an Action open (see {@link LedgerEntry.releaseAction}):
     * a held Action would freeze every router transition — canon delivery and
     * navigation alike — for as long as the user leaves the retry toast up.
     * The predictions yield to canon truth at the flush; the envelopes and
     * mutation IDs stay in the ledger for honest same-ID redelivery.
     */
    const releaseActionsForPausedQueue = useCallback(() => {
      const paused: string[] = []
      for (const entry of ledgerRef.current.values()) {
        if (entry.delivery === "queued" || entry.delivery === "uncertain") {
          entry.releaseAction.resolve()
          paused.push(entry.envelope.mutationId)
        }
      }
      if (paused.length === 0) return
      setPausedIds((current) => {
        const next = new Set(current)
        for (const mutationId of paused) next.add(mutationId)
        return next
      })
    }, [])

    const reduceOptimistic = useCallback(
      (
        frame: ReplayFrame<State, Error>,
        update: OptimisticUpdate<Invocation>
      ): ReplayFrame<State, Error> => {
        // Replay is idempotent per mutation ID: React may hold both an
        // original update and its resume-time re-add (UNN-682) in the same
        // optimistic queue, and how long a settled update stays replayed is
        // React's timing, not a package contract. Deciding "one application
        // per ID" here makes every downstream fact independent of that.
        if (frame.replayedMutationIds.includes(update.envelope.mutationId)) {
          return frame
        }

        const replayedFrame = {
          ...frame,
          replayedMutationIds: [
            ...frame.replayedMutationIds,
            update.envelope.mutationId,
          ],
        }
        if (frame.refusedIds.has(update.envelope.mutationId)) {
          return replayedFrame
        }
        if (frame.pausedIds.has(update.envelope.mutationId)) {
          return replayedFrame
        }

        const acceptedStamp = frame.acceptedById.get(update.envelope.mutationId)
        if (
          acceptedStamp &&
          covers({ revisions: frame.revisions }, acceptedStamp)
        ) {
          return replayedFrame
        }

        const predicted = mutationFor(update.envelope.invocation).predict(
          frame.value,
          runtimeInvocation(update.envelope.invocation).args,
          mutationContext(update.envelope.mutationId)
        )
        if (predicted.ok) {
          return { ...replayedFrame, value: predicted.value }
        }

        if (
          frame.refusals.some(
            (refusal) => refusal.mutationId === update.envelope.mutationId
          )
        ) {
          return replayedFrame
        }

        return {
          ...replayedFrame,
          refusals: [
            ...frame.refusals,
            {
              mutationId: update.envelope.mutationId,
              error: predicted.error,
            },
          ],
        }
      },
      []
    )

    const passthrough = useMemo<ReplayFrame<State, Error>>(
      () => ({
        value: canon.value,
        revisions: canon.revisions,
        acceptedById,
        refusedIds,
        pausedIds,
        replayedMutationIds: [],
        refusals: [],
      }),
      [acceptedById, canon, pausedIds, refusedIds]
    )

    const [frame, addOptimistic] = useOptimistic<
      ReplayFrame<State, Error>,
      OptimisticUpdate<Invocation>
    >(passthrough, reduceOptimistic)

    const settleDomainRejection = useCallback(
      (entry: LedgerEntry<Invocation, Error>, error: Error) => {
        const lifecycleError = { kind: "domain", error } as const
        entry.delivery = "rejected"
        entry.accepted.resolve(err(lifecycleError))
        entry.canonized.resolve(err(lifecycleError))
        setRefusedIds((current) => {
          const next = new Set(current)
          next.add(entry.envelope.mutationId)
          return next
        })
        releaseAction(entry)
        removeFromQueue(queueRef.current, entry.envelope.mutationId)
        ledgerRef.current.delete(entry.envelope.mutationId)
      },
      [releaseAction]
    )

    const handleDelivery = useCallback(
      async (entry: LedgerEntry<Invocation, Error>) => {
        try {
          const outcome = await options.send(entry.envelope)
          if (entry.delivery !== "sending") return

          if (!outcome.ok) {
            settleDomainRejection(entry, outcome.error)
          } else {
            entry.delivery = "accepted"
            entry.acceptedStamp = outcome.value
            entry.accepted.resolve(ok(outcome.value))
            removeFromQueue(queueRef.current, entry.envelope.mutationId)
            if (activeTokenRef.current) {
              recordAcceptance(entry.envelope.mutationId, outcome.value)
              setAcceptedById((current) => {
                const next = new Map(current)
                next.set(entry.envelope.mutationId, outcome.value)
                return next
              })
            }
            // Settle the Action at the terminal acceptance, not canonization.
            // The RSC payload carrying the covering canon is parked behind
            // this very Action; settling releases it, and React commits the
            // parked canon and the optimistic revert atomically — the
            // prediction hands off to the authoritative value with no gap.
            // Holding on for coverage instead is a deadlock: coverage can
            // only be observed after a commit this Action is blocking.
            releaseAction(entry)
          }
        } catch (error) {
          try {
            classifyDeliveryError(error)
          } catch (controlFlow) {
            if (entry.delivery === "sending") {
              const lifecycleError = { kind: "delivery-cancelled" } as const
              entry.delivery = "cancelled"
              entry.accepted.resolve(err(lifecycleError))
              entry.canonized.resolve(err(lifecycleError))
              removeFromQueue(queueRef.current, entry.envelope.mutationId)
              ledgerRef.current.delete(entry.envelope.mutationId)
              entry.releaseAction.reject(controlFlow)
            }
            if (activeTokenRef.current) renderCoordinator()
            return
          }

          if (entry.delivery === "sending") {
            const retryDelay =
              error instanceof RetryableDeliveryError
                ? DELIVERY_RETRY_DELAYS_MS[entry.retryAttempts]
                : undefined
            if (retryDelay === undefined) {
              // An ordinary throw (the commit may exist) or an exhausted
              // redelivery budget: hold the envelope as honestly uncertain.
              // The wait for a manual retry is unbounded, so every held
              // Action must settle now — this entry's and the queued tail's.
              entry.delivery = "uncertain"
              releaseActionsForPausedQueue()
            } else {
              // A known-clean miss: redeliver the same envelope and mutation
              // ID after a bounded backoff. The entry stays at the queue head,
              // so ordering holds and later mutations wait.
              entry.retryAttempts += 1
              entry.delivery = "retry-scheduled"
              setTimeout(() => {
                if (entry.delivery !== "retry-scheduled") return
                entry.delivery = "queued"
                if (activeTokenRef.current) renderCoordinator()
              }, retryDelay)
            }
          }
        }

        if (activeTokenRef.current) renderCoordinator()
      },
      [
        recordAcceptance,
        releaseAction,
        releaseActionsForPausedQueue,
        settleDomainRejection,
      ]
    )

    const reconcileRefusals = useCallback(() => {
      let changed = false

      for (const refusal of frame.refusals) {
        const entry = ledgerRef.current.get(refusal.mutationId)
        if (!entry || entry.replayRefusal !== undefined) continue

        entry.replayRefusal = refusal.error
        conflictsRef.current = [
          ...conflictsRef.current,
          {
            mutationId: refusal.mutationId,
            invocation: entry.envelope.invocation,
            error: refusal.error,
          },
        ]
        changed = true
        setRefusedIds((current) => {
          const next = new Set(current)
          next.add(refusal.mutationId)
          return next
        })

        // A retry-scheduled envelope is retractable like a queued one: no
        // terminal receipt exists (the retryable classification proves the
        // authority did not commit), and its redelivery is client-initiated.
        if (entry.delivery !== "queued" && entry.delivery !== "retry-scheduled")
          continue

        const lifecycleError = {
          kind: "replay-refused",
          error: refusal.error,
        } as const
        entry.delivery = "cancelled"
        entry.accepted.resolve(err(lifecycleError))
        entry.canonized.resolve(err(lifecycleError))
        releaseAction(entry)
        removeFromQueue(queueRef.current, refusal.mutationId)
        ledgerRef.current.delete(refusal.mutationId)
      }

      return changed
    }, [frame.refusals, releaseAction])

    const reconcileCoverage = useCallback(() => {
      let changed = false

      for (const entry of ledgerRef.current.values()) {
        if (
          entry.delivery !== "accepted" ||
          !entry.acceptedStamp ||
          !covers(canon, entry.acceptedStamp)
        ) {
          continue
        }

        // The entry's Action already settled at acceptance (UNN-682);
        // canonization is bookkeeping only.
        entry.canonized.resolve(ok(undefined))
        removeAcceptance(entry.envelope.mutationId)
        ledgerRef.current.delete(entry.envelope.mutationId)
        changed = true
      }

      return changed
    }, [canon, removeAcceptance])

    const pruneReducerMetadata = useCallback(() => {
      const replayedIds = new Set(frame.replayedMutationIds)

      if ([...acceptedById.keys()].some((id) => !replayedIds.has(id))) {
        setAcceptedById(
          new Map([...acceptedById].filter(([id]) => replayedIds.has(id)))
        )
      }
      if ([...refusedIds].some((id) => !replayedIds.has(id))) {
        setRefusedIds(
          new Set([...refusedIds].filter((id) => replayedIds.has(id)))
        )
      }
      if ([...pausedIds].some((id) => !replayedIds.has(id))) {
        setPausedIds(
          new Set([...pausedIds].filter((id) => replayedIds.has(id)))
        )
      }
    }, [acceptedById, frame.replayedMutationIds, pausedIds, refusedIds])

    const deliverQueueHead = useCallback(() => {
      const headId = queueRef.current[0]
      if (!headId) return false

      const entry = ledgerRef.current.get(headId)
      if (!entry || entry.delivery !== "queued") return false

      entry.delivery = "sending"
      void handleDelivery(entry)
      return true
    }, [handleDelivery])

    useEffect(() => {
      const refused = reconcileRefusals()
      const canonized = reconcileCoverage()
      const delivering = deliverQueueHead()
      pruneReducerMetadata()
      if (refused || canonized || delivering) renderCoordinator()
    }, [
      deliverQueueHead,
      frame,
      pruneReducerMetadata,
      reconcileCoverage,
      reconcileRefusals,
    ])

    useEffect(() => {
      const token = {}
      activeTokenRef.current = token

      return () => {
        activeTokenRef.current = null
        queueMicrotask(() => {
          if (activeTokenRef.current !== null) return

          // Unmount ends this root's ability to *observe* an outcome; it does
          // not repeal the user's intent. An envelope that never went out —
          // typically a debounced autosave flushed from a leaf's unmount
          // cleanup, where the leaf tears down before the provider — is sent
          // fire-and-forget on the way down. Safe by construction: the
          // canonical envelope and durable mutation ID make redelivery
          // effectively-once at the authority. Queue order is preserved,
          // because two edits to the same field must not race.
          //
          // Only never-delivered entries qualify. A `sending`/`uncertain`
          // entry may already have committed, and its receipt — not a second
          // send — is what would resolve it.
          const undelivered = queueRef.current
            .map((mutationId) => ledgerRef.current.get(mutationId))
            .filter((entry) => entry?.delivery === "queued")
          void undelivered.reduce(
            (chain, entry) =>
              chain.then(() =>
                entry
                  ? options.send(entry.envelope).then(noop, noop)
                  : undefined
              ),
            Promise.resolve<void>(undefined)
          )

          for (const entry of ledgerRef.current.values()) {
            // `unknown` stays honest for a farewell send: it left, but no
            // mounted root remains to learn whether the authority accepted it.
            const outcome = entry.acceptedStamp ? "accepted" : "unknown"
            const lifecycleError = {
              kind: "root-unmounted",
              outcome,
            } as const
            entry.accepted.resolve(err(lifecycleError))
            entry.canonized.resolve(err(lifecycleError))
            entry.releaseAction.resolve()
          }
          ledgerRef.current.clear()
          queueRef.current = []
        })
      }
    }, [])

    /**
     * Opens (or re-opens) the optimistic Action that renders this entry's
     * prediction. The Action's lifetime is the entry's *actively progressing*
     * delivery: it settles at the terminal acceptance or rejection, at Next
     * control flow, when the queue pauses on an unbounded-uncertain head, or
     * on unmount — never held for canonization (see
     * {@link LedgerEntry.releaseAction} for why holding longer deadlocks).
     */
    const openDeliveryAction = useCallback(
      (entry: LedgerEntry<Invocation, Error>) => {
        entry.releaseAction = createDeferred()
        startTransition(async () => {
          addOptimistic({
            envelope: entry.envelope,
          })
          renderCoordinator()
          await entry.releaseAction.promise
        })
      },
      [addOptimistic]
    )

    const mutate = useCallback(
      (invocation: Invocation): Result<MutationReceipt<Error>, Error> => {
        const mutationId = globalThis.crypto.randomUUID()
        const envelope = freezeEnvelope(
          options.protocol.id,
          mutationId,
          invocation
        )
        const predicted = mutationFor(invocation).predict(
          frame.value,
          runtimeInvocation(envelope.invocation).args,
          mutationContext(envelope.mutationId)
        )
        if (!predicted.ok) return err(predicted.error)

        const entry: LedgerEntry<Invocation, Error> = {
          envelope,
          accepted: createDeferred(),
          canonized: createDeferred(),
          releaseAction: createDeferred(),
          delivery: "queued",
          retryAttempts: 0,
        }
        ledgerRef.current.set(mutationId, entry)
        queueRef.current.push(mutationId)
        openDeliveryAction(entry)

        // Intent recorded while the queue is paused on an uncertain head will
        // not progress until a manual retry, so its Action must not stay open
        // and its prediction joins the paused set with the rest of the queue.
        const headEntry = ledgerRef.current.get(queueRef.current[0] ?? "")
        if (headEntry?.delivery === "uncertain") {
          entry.releaseAction.resolve()
          setPausedIds((current) => new Set(current).add(mutationId))
        }

        return ok({
          id: mutationId,
          accepted: entry.accepted.promise,
          canonized: entry.canonized.promise,
        })
      },
      [frame.value, openDeliveryAction]
    )

    const retryDelivery = useCallback(() => {
      const headId = queueRef.current[0]
      if (!headId) return

      const entry = ledgerRef.current.get(headId)
      if (!entry || entry.delivery !== "uncertain") return

      // A manual retry earns a fresh automatic-redelivery budget.
      entry.retryAttempts = 0
      entry.delivery = "queued"

      // The queue is progressing again: leave the paused set and re-open an
      // Action per queued entry so every prediction is replayed again even if
      // React already dropped the settled originals. Re-adds share the
      // original mutation IDs; the reducer's per-ID idempotence makes an
      // original/re-add pair apply once.
      setPausedIds((current) => {
        if (current.size === 0) return current
        const next = new Set(current)
        for (const mutationId of queueRef.current) next.delete(mutationId)
        return next
      })
      for (const mutationId of queueRef.current) {
        const queued = ledgerRef.current.get(mutationId)
        if (queued?.delivery === "queued") openDeliveryAction(queued)
      }
      renderCoordinator()
    }, [openDeliveryAction])

    const queueHead = queueRef.current[0]
    const headDelivery = queueHead
      ? ledgerRef.current.get(queueHead)?.delivery
      : undefined

    return {
      value: frame.value,
      mutate: mutate as ProtocolPredictedRoot<Protocol>["mutate"],
      retryDelivery,
      retryRefresh: incorporation.retryRefresh,
      status: {
        pending: ledgerRef.current.size,
        delivery:
          headDelivery === "uncertain"
            ? "uncertain"
            : headDelivery === "sending" ||
                headDelivery === "queued" ||
                headDelivery === "retry-scheduled"
              ? "sending"
              : "idle",
        ...incorporation.status,
      },
      conflicts: conflictsRef.current,
    }
  }
}

/**
 * Creates a read-only React observed-root hook.
 * @param options Refresh and optional invalidation dependencies.
 * @returns A hook exposing authoritative state and incorporation status without mutation controls.
 */
export function createObservedRoot(options: ObservedRootOptions) {
  return function useObservedRoot<State>({
    canon,
  }: PredictedRootInput<State>): ObservedRoot<State> {
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
  createNoRealtimeInvalidationAdapter,
  useSnapshotRefresh,
  withPollingFallback,
  type AxisInvalidation,
  type FreshnessStatus,
  type IncorporationStatus,
  type InvalidationAdapter,
  type InvalidationPublisher,
  type InvalidationSubscription,
  type InvalidationStatus,
  type PollingFallbackOptions,
  type RefreshAdapter,
  type RefreshStallReason,
} from "./refresh"
export type { MutationEnvelope } from "./authority"
