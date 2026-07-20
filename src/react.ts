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
  MutationDefinition,
  MutationInvocation,
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

export type MutationLifecycleError<Error> =
  | { readonly kind: "domain"; readonly error: Error }
  | { readonly kind: "replay-refused"; readonly error: Error }
  | {
      readonly kind: "root-unmounted"
      readonly outcome: "unknown" | "accepted"
    }

export interface MutationReceipt<Error> {
  readonly id: string
  readonly accepted: Promise<
    Result<AcceptedStamp, MutationLifecycleError<Error>>
  >
  readonly canonized: Promise<Result<void, MutationLifecycleError<Error>>>
}

export interface ReplayConflict<Invocation, Error> {
  readonly mutationId: string
  readonly invocation: Invocation
  readonly error: Error
}

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

export interface ObservedRoot<State> {
  readonly value: State
  readonly retryRefresh: () => void
  readonly status: IncorporationStatus
}

type MutationOf<Protocol> =
  Protocol extends ProtocolDefinition<string, infer Mutations>
    ? Mutations[number]
    : never

type StateOf<Protocol> =
  MutationOf<Protocol> extends MutationDefinition<
    string,
    infer _Schema,
    infer State,
    infer _Error
  >
    ? State
    : never

type ErrorOf<Protocol> =
  MutationOf<Protocol> extends MutationDefinition<
    string,
    infer _Schema,
    infer _State,
    infer Error
  >
    ? Error
    : never

export interface PredictedRootOptions<
  Protocol extends ProtocolDefinition<string, readonly AnyMutationDefinition[]>,
> {
  readonly protocol: Protocol
  /**
   * Delivers one envelope after framework control-flow throws have been
   * classified. An ordinary throw at this seam means delivery is uncertain.
   */
  readonly send: (
    envelope: MutationEnvelope<ProtocolInvocation<Protocol>>
  ) => Promise<Result<AcceptedStamp, ErrorOf<Protocol>>>
  readonly refresh: () => RefreshAdapter
  readonly invalidations?: InvalidationAdapter
}

export interface PredictedRootInput<State> {
  readonly canon: Canon<State>
}

export interface ObservedRootOptions {
  readonly refresh: () => RefreshAdapter
  readonly invalidations?: InvalidationAdapter
}

interface Deferred<Value> {
  readonly promise: Promise<Value>
  readonly settled: boolean
  resolve(value: Value): void
}

function createDeferred<Value>(): Deferred<Value> {
  let resolvePromise: (value: Value) => void = () => undefined
  let settled = false
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve
  })

  return {
    promise,
    get settled() {
      return settled
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
  readonly releaseAction: Deferred<void>
  delivery: DeliveryState
  acceptedStamp?: AcceptedStamp
  replayRefusal?: Error
}

interface OptimisticUpdate<Invocation> {
  readonly mutationId: string
  readonly invocation: Invocation
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
  readonly replayedMutationIds: readonly string[]
  readonly refusals: readonly ReplayRefusal<Error>[]
}

interface RuntimeMutation<State, Error> {
  readonly predict: (state: State, args: unknown) => Result<State, Error>
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

function removeFromQueue(queue: string[], mutationId: string): void {
  const index = queue.indexOf(mutationId)
  if (index >= 0) queue.splice(index, 1)
}

export function createPredictedRoot<
  const Protocol extends ProtocolDefinition<
    string,
    readonly AnyMutationDefinition[]
  >,
>(options: PredictedRootOptions<Protocol>) {
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
  }: PredictedRootInput<State>): PredictedRoot<State, Invocation, Error> {
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

    const reduceOptimistic = useCallback(
      (
        frame: ReplayFrame<State, Error>,
        update: OptimisticUpdate<Invocation>
      ): ReplayFrame<State, Error> => {
        const replayedFrame = {
          ...frame,
          replayedMutationIds: [
            ...frame.replayedMutationIds,
            update.mutationId,
          ],
        }
        if (frame.refusedIds.has(update.mutationId)) return replayedFrame

        const acceptedStamp = frame.acceptedById.get(update.mutationId)
        if (
          acceptedStamp &&
          covers({ revisions: frame.revisions }, acceptedStamp)
        ) {
          return replayedFrame
        }

        const predicted = mutationFor(update.invocation).predict(
          frame.value,
          runtimeInvocation(update.invocation).args
        )
        if (predicted.ok) {
          return { ...replayedFrame, value: predicted.value }
        }

        if (
          frame.refusals.some(
            (refusal) => refusal.mutationId === update.mutationId
          )
        ) {
          return replayedFrame
        }

        return {
          ...replayedFrame,
          refusals: [
            ...frame.refusals,
            { mutationId: update.mutationId, error: predicted.error },
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
        replayedMutationIds: [],
        refusals: [],
      }),
      [acceptedById, canon, refusedIds]
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
          }
        } catch {
          if (entry.delivery === "sending") entry.delivery = "uncertain"
        }

        if (activeTokenRef.current) renderCoordinator()
      },
      [recordAcceptance, settleDomainRejection]
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

        if (entry.delivery !== "queued") continue

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

        entry.canonized.resolve(ok(undefined))
        releaseAction(entry)
        removeAcceptance(entry.envelope.mutationId)
        ledgerRef.current.delete(entry.envelope.mutationId)
        changed = true
      }

      return changed
    }, [canon, releaseAction, removeAcceptance])

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
    }, [acceptedById, frame.replayedMutationIds, refusedIds])

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

          for (const entry of ledgerRef.current.values()) {
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

    const mutate = useCallback(
      (invocation: Invocation): Result<MutationReceipt<Error>, Error> => {
        const predicted = mutationFor(invocation).predict(
          frame.value,
          runtimeInvocation(invocation).args
        )
        if (!predicted.ok) return err(predicted.error)

        const mutationId = globalThis.crypto.randomUUID()
        const entry: LedgerEntry<Invocation, Error> = {
          envelope: freezeEnvelope(options.protocol.id, mutationId, invocation),
          accepted: createDeferred(),
          canonized: createDeferred(),
          releaseAction: createDeferred(),
          delivery: "queued",
        }
        ledgerRef.current.set(mutationId, entry)
        queueRef.current.push(mutationId)

        startTransition(async () => {
          addOptimistic({
            mutationId,
            invocation: entry.envelope.invocation,
          })
          renderCoordinator()
          await entry.releaseAction.promise
        })

        return ok({
          id: mutationId,
          accepted: entry.accepted.promise,
          canonized: entry.canonized.promise,
        })
      },
      [addOptimistic, frame.value]
    )

    const retryDelivery = useCallback(() => {
      const headId = queueRef.current[0]
      if (!headId) return

      const entry = ledgerRef.current.get(headId)
      if (!entry || entry.delivery !== "uncertain") return

      entry.delivery = "queued"
      renderCoordinator()
    }, [])

    const queueHead = queueRef.current[0]
    const headDelivery = queueHead
      ? ledgerRef.current.get(queueHead)?.delivery
      : undefined

    return {
      value: frame.value,
      mutate,
      retryDelivery,
      retryRefresh: incorporation.retryRefresh,
      status: {
        pending: ledgerRef.current.size,
        delivery:
          headDelivery === "uncertain"
            ? "uncertain"
            : headDelivery === "sending" || headDelivery === "queued"
              ? "sending"
              : "idle",
        ...incorporation.status,
      },
      conflicts: conflictsRef.current,
    }
  }
}

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
  useRouterRefresh,
  useSnapshotRefresh,
  type AxisInvalidation,
  type FreshnessStatus,
  type IncorporationStatus,
  type InvalidationAdapter,
  type InvalidationPublisher,
  type InvalidationSubscription,
  type InvalidationStatus,
  type RefreshAdapter,
  type RefreshStallReason,
} from "./refresh"
export type { MutationEnvelope } from "./authority"
