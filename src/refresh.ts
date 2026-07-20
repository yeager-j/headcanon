"use client"

import { useRouter } from "next/navigation"
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useTransition,
} from "react"

import {
  axisId,
  covers,
  type AcceptedStamp,
  type AxisId,
  type Canon,
  type Revision,
  type RevisionVector,
} from "./revisions"

export const ROUTER_ACCEPTANCE_GRACE_MS = 250
export const SNAPSHOT_ACCEPTANCE_GRACE_MS = 0
export const UNCOVERED_REFRESH_RETRY_MS = 1_000

export interface RefreshAdapter {
  readonly acceptanceGraceMs: number
  request(): void | Promise<void>
}

export type RefreshStallReason = "behind" | "missing-axis" | "refresh-error"

export type FreshnessStatus = "current" | "grace" | "refreshing" | "stalled"

export interface AxisInvalidation {
  readonly eventId: string
  readonly axis: AxisId
  readonly revision: Revision
}

export type InvalidationStatus =
  | "disabled"
  | "active"
  | "reauthorizing"
  | "polling"
  | "unavailable"

export interface InvalidationSubscription {
  readonly axes: readonly AxisId[]
  readonly onInvalidation: (invalidation: AxisInvalidation) => void
  readonly onStatusChange: (status: InvalidationStatus) => void
}

export interface InvalidationAdapter {
  readonly initialStatus: InvalidationStatus
  subscribe(subscription: InvalidationSubscription): () => void
}

export interface IncorporationStatus {
  readonly freshness: FreshnessStatus
  readonly invalidations: InvalidationStatus
  readonly missingAxes: readonly AxisId[]
  readonly stallReason: RefreshStallReason | null
}

interface RefreshState {
  readonly freshness: FreshnessStatus
  readonly stallReason: RefreshStallReason | null
}

const CURRENT_REFRESH_STATE: RefreshState = {
  freshness: "current",
  stallReason: null,
}

function maxRevision(
  target: Map<AxisId, Revision>,
  revisions: RevisionVector
): boolean {
  let changed = false

  for (const [rawAxis, revision] of Object.entries(revisions)) {
    const axis = axisId(rawAxis)
    const current = target.get(axis)
    if (current !== undefined && current >= revision) continue

    target.set(axis, revision)
    changed = true
  }

  return changed
}

function revisionsFrom(
  accepted: ReadonlyMap<string, AcceptedStamp>,
  observed: ReadonlyMap<AxisId, Revision>,
  canon: Canon<unknown>
): RevisionVector {
  const revisions = Object.create(null) as Record<AxisId, Revision>

  for (const stamp of accepted.values()) {
    for (const [rawAxis, revision] of Object.entries(stamp.revisions)) {
      const axis = axisId(rawAxis)
      const current = revisions[axis]
      if (current === undefined || revision > current)
        revisions[axis] = revision
    }
  }

  for (const [axis, revision] of observed) {
    if (canon.revisions[axis] === undefined) continue
    const current = revisions[axis]
    if (current === undefined || revision > current) revisions[axis] = revision
  }

  return revisions
}

function missingAxes(
  canon: Canon<unknown>,
  requirements: RevisionVector
): readonly AxisId[] {
  return Object.keys(requirements)
    .map(axisId)
    .filter((axis) => canon.revisions[axis] === undefined)
}

export function useRouterRefresh(): RefreshAdapter {
  const router = useRouter()

  return useMemo(
    () => ({
      acceptanceGraceMs: ROUTER_ACCEPTANCE_GRACE_MS,
      request: () => router.refresh(),
    }),
    [router]
  )
}

export function useSnapshotRefresh(
  refetch: () => void | Promise<void>
): RefreshAdapter {
  return useMemo(
    () => ({
      acceptanceGraceMs: SNAPSHOT_ACCEPTANCE_GRACE_MS,
      request: refetch,
    }),
    [refetch]
  )
}

export interface IncorporationCoordinator {
  readonly status: IncorporationStatus
  readonly retryRefresh: () => void
  readonly recordAcceptance: (mutationId: string, stamp: AcceptedStamp) => void
  readonly removeAcceptance: (mutationId: string) => void
}

export function useIncorporation<State>(
  canon: Canon<State>,
  refresh: RefreshAdapter,
  invalidations?: InvalidationAdapter
): IncorporationCoordinator {
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  const canonRef = useRef<Canon<unknown>>(canon)
  canonRef.current = canon
  const mountedRef = useRef(false)
  const acceptedRef = useRef(new Map<string, AcceptedStamp>())
  const observedRef = useRef(new Map<AxisId, Revision>())
  const activeRefreshRef = useRef(false)
  const activeCompletionRef = useRef<"canon" | "request" | null>(null)
  const requestedCanonRef = useRef<Canon<unknown> | null>(null)
  const attemptsRef = useRef(0)
  const failedAttemptsRef = useRef(0)
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduledRefreshRef = useRef(false)
  const startRefreshRef = useRef<() => void>(() => undefined)
  const [refreshState, setRefreshState] = useState(CURRENT_REFRESH_STATE)
  const [invalidationStatus, setInvalidationStatus] =
    useState<InvalidationStatus>(invalidations?.initialStatus ?? "disabled")
  const [, renderRequirements] = useReducer(
    (revision: number) => revision + 1,
    0
  )
  const [, startRefreshTransition] = useTransition()

  const clearGraceTimer = useCallback(() => {
    if (graceTimerRef.current === null) return
    clearTimeout(graceTimerRef.current)
    graceTimerRef.current = null
  }, [])

  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current === null) return
    clearTimeout(retryTimerRef.current)
    retryTimerRef.current = null
  }, [])

  const requirements = useCallback(
    () =>
      revisionsFrom(acceptedRef.current, observedRef.current, canonRef.current),
    []
  )

  const isCovered = useCallback(() => {
    return covers(canonRef.current, { revisions: requirements() })
  }, [requirements])

  const resetAttemptBudget = useCallback(() => {
    attemptsRef.current = activeRefreshRef.current ? 1 : 0
    failedAttemptsRef.current = 0
    clearRetryTimer()
  }, [clearRetryTimer])

  const scheduleRefresh = useCallback(() => {
    if (activeRefreshRef.current || scheduledRefreshRef.current) return

    scheduledRefreshRef.current = true
    setRefreshState({ freshness: "refreshing", stallReason: null })
    queueMicrotask(() => {
      scheduledRefreshRef.current = false
      if (mountedRef.current) startRefreshRef.current()
    })
  }, [])

  const completeRefresh = useCallback(
    (failed: boolean) => {
      if (!activeRefreshRef.current || !mountedRef.current) return

      if (failed) failedAttemptsRef.current += 1
      activeRefreshRef.current = false
      activeCompletionRef.current = null
      requestedCanonRef.current = null

      if (isCovered()) {
        attemptsRef.current = 0
        failedAttemptsRef.current = 0
        setRefreshState(CURRENT_REFRESH_STATE)
        return
      }

      if (attemptsRef.current >= 2) {
        const absentAxes = missingAxes(canonRef.current, requirements())
        setRefreshState({
          freshness: "stalled",
          stallReason:
            failedAttemptsRef.current >= 2
              ? "refresh-error"
              : absentAxes.length > 0
                ? "missing-axis"
                : "behind",
        })
        return
      }

      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null
        startRefreshRef.current()
      }, UNCOVERED_REFRESH_RETRY_MS)
    },
    [isCovered, requirements]
  )

  const startRefresh = useCallback(() => {
    if (activeRefreshRef.current || isCovered() || !mountedRef.current) {
      if (isCovered()) setRefreshState(CURRENT_REFRESH_STATE)
      return
    }

    clearGraceTimer()
    clearRetryTimer()
    activeRefreshRef.current = true
    activeCompletionRef.current = "canon"
    requestedCanonRef.current = canonRef.current
    attemptsRef.current += 1
    setRefreshState({ freshness: "refreshing", stallReason: null })

    // React 19 entangles isPending across overlapping async Actions. The held
    // optimistic Action would therefore hide this transition's settled edge.
    // A returned Promise owns completion; a void carrier completes when it
    // delivers the next canon through this hook's input.
    startRefreshTransition(async () => {
      let completion: void | Promise<void>
      try {
        completion = refreshRef.current.request()
      } catch {
        completeRefresh(true)
        return
      }

      if (completion === undefined) return
      activeCompletionRef.current = "request"
      try {
        await completion
        completeRefresh(false)
      } catch {
        completeRefresh(true)
      }
    })
  }, [clearGraceTimer, clearRetryTimer, completeRefresh, isCovered])
  startRefreshRef.current = startRefresh

  const beginAcceptanceRefresh = useCallback(() => {
    if (isCovered()) return

    resetAttemptBudget()
    if (activeRefreshRef.current) return

    const graceMs = refreshRef.current.acceptanceGraceMs
    if (graceMs === 0) {
      scheduleRefresh()
      return
    }

    if (graceTimerRef.current !== null) return
    setRefreshState({ freshness: "grace", stallReason: null })
    graceTimerRef.current = setTimeout(() => {
      graceTimerRef.current = null
      scheduleRefresh()
    }, graceMs)
  }, [isCovered, resetAttemptBudget, scheduleRefresh])

  const recordAcceptance = useCallback(
    (mutationId: string, stamp: AcceptedStamp) => {
      acceptedRef.current.set(mutationId, stamp)
      maxRevision(observedRef.current, stamp.revisions)
      renderRequirements()
      beginAcceptanceRefresh()
    },
    [beginAcceptanceRefresh]
  )

  const removeAcceptance = useCallback(
    (mutationId: string) => {
      if (!acceptedRef.current.delete(mutationId)) return
      renderRequirements()
      if (!isCovered()) return

      clearGraceTimer()
      clearRetryTimer()
      attemptsRef.current = 0
      failedAttemptsRef.current = 0
      setRefreshState(CURRENT_REFRESH_STATE)
    },
    [clearGraceTimer, clearRetryTimer, isCovered]
  )

  const observeInvalidation = useCallback(
    (invalidation: AxisInvalidation) => {
      const canonRevision = canonRef.current.revisions[invalidation.axis]
      if (
        canonRevision === undefined ||
        invalidation.revision <= canonRevision
      ) {
        return
      }

      const observedRevision = observedRef.current.get(invalidation.axis)
      if (
        observedRevision !== undefined &&
        invalidation.revision <= observedRevision
      ) {
        return
      }

      observedRef.current.set(invalidation.axis, invalidation.revision)
      renderRequirements()
      resetAttemptBudget()
      clearGraceTimer()
      scheduleRefresh()
    },
    [clearGraceTimer, resetAttemptBudget, scheduleRefresh]
  )

  const retryRefresh = useCallback(() => {
    if (isCovered()) {
      setRefreshState(CURRENT_REFRESH_STATE)
      return
    }

    resetAttemptBudget()
    clearGraceTimer()
    scheduleRefresh()
  }, [clearGraceTimer, isCovered, resetAttemptBudget, scheduleRefresh])

  const rawObservedAxes = Object.keys(canon.revisions).sort()
  const observedAxesKey = JSON.stringify(rawObservedAxes)
  const observedAxes = useMemo(
    () => rawObservedAxes.map(axisId),
    [observedAxesKey]
  )

  useEffect(() => {
    setInvalidationStatus(invalidations?.initialStatus ?? "disabled")
    if (!invalidations) return

    return invalidations.subscribe({
      axes: observedAxes,
      onInvalidation: observeInvalidation,
      onStatusChange: setInvalidationStatus,
    })
  }, [invalidations, observeInvalidation, observedAxes])

  useEffect(() => {
    if (
      activeRefreshRef.current &&
      activeCompletionRef.current === "canon" &&
      requestedCanonRef.current !== canon
    ) {
      completeRefresh(false)
    }

    if (!isCovered()) return

    clearGraceTimer()
    clearRetryTimer()
    attemptsRef.current = 0
    failedAttemptsRef.current = 0
    setRefreshState(CURRENT_REFRESH_STATE)
  }, [canon, clearGraceTimer, clearRetryTimer, completeRefresh, isCovered])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      clearGraceTimer()
      clearRetryTimer()
    }
  }, [clearGraceTimer, clearRetryTimer])

  const currentRequirements = requirements()

  return {
    status: {
      freshness: refreshState.freshness,
      invalidations: invalidationStatus,
      missingAxes: missingAxes(canonRef.current, currentRequirements),
      stallReason: refreshState.stallReason,
    },
    retryRefresh,
    recordAcceptance,
    removeAcceptance,
  }
}
