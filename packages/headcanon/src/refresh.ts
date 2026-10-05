"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useTransition,
} from "react"

import type {
  AxisInvalidation,
  InvalidationAdapter,
  InvalidationStatus,
  InvalidationSubscription,
} from "./invalidation"
import {
  axisId,
  covers,
  defineCoordinate,
  revisionAt,
  type AcceptedStamp,
  type AxisId,
  type Canon,
  type Revision,
  type RevisionVector,
} from "./revisions"

/** Grace period used by snapshot carriers before an acceptance refresh. */
export const SNAPSHOT_ACCEPTANCE_GRACE_MS = 0
/** Delay before retrying one refresh that still does not cover an accepted stamp. */
export const UNCOVERED_REFRESH_RETRY_MS = 1_000

/** Refresh carrier used to obtain a newer authoritative canon. */
export interface RefreshAdapter {
  readonly acceptanceGraceMs: number
  request(): void | Promise<void>
}

/** Timing and visibility policy for degraded invalidation polling. */
export interface PollingFallbackOptions {
  readonly intervalMs: number
  readonly pauseWhenHidden?: boolean
}

function needsPollingFallback(status: InvalidationStatus): boolean {
  return (
    status === "disabled" ||
    status === "reauthorizing" ||
    status === "unavailable"
  )
}

function pollingStatus(status: InvalidationStatus): InvalidationStatus {
  return needsPollingFallback(status) ? "polling" : status
}

/**
 * Preserves bounded liveness through the subscribed root's existing refresh
 * path whenever its primary invalidation transport is unavailable.
 *
 * The wrapper reports `polling` while the primary adapter is disabled,
 * reauthorizing, or unavailable, and requests refreshes at the configured
 * interval through `onSubscriptionGap`. It stops the timer on unsubscribe and
 * can pause while the document is hidden. When the primary transport becomes
 * active, polling stops and the original status is forwarded. This is a
 * liveness fallback, not a second data source: the root still obtains state
 * only through its existing refresh carrier.
 *
 * @param primary Push invalidation adapter to wrap.
 * @param options Polling interval and visibility policy.
 * @returns An invalidation adapter with polling fallback.
 * @throws Error when `intervalMs` is not a finite positive number.
 */
export function withPollingFallback(
  primary: InvalidationAdapter,
  options: PollingFallbackOptions
): InvalidationAdapter {
  if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
    throw new Error("Polling fallback intervalMs must be positive")
  }

  const pauseWhenHidden = options.pauseWhenHidden ?? true

  return {
    get initialStatus() {
      return pollingStatus(primary.initialStatus)
    },
    subscribe(subscription) {
      let polling = needsPollingFallback(primary.initialStatus)
      let stopped = false
      let interval: ReturnType<typeof setInterval> | null = null

      const hidden = () =>
        pauseWhenHidden &&
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"

      const stopInterval = () => {
        if (interval === null) return
        clearInterval(interval)
        interval = null
      }

      const requestRefresh = () => {
        if (!stopped && polling && !hidden()) {
          subscription.onSubscriptionGap?.()
        }
      }

      const startInterval = () => {
        if (stopped || !polling || hidden() || interval !== null) return
        interval = setInterval(requestRefresh, options.intervalMs)
      }

      const reconcileInterval = () => {
        if (polling) startInterval()
        else stopInterval()
      }

      const onStatusChange: InvalidationSubscription["onStatusChange"] = (
        status
      ) => {
        if (status === "active") polling = false
        else if (needsPollingFallback(status)) polling = true

        reconcileInterval()
        subscription.onStatusChange(polling ? "polling" : status)
      }

      const onVisibilityChange = () => {
        if (hidden()) {
          stopInterval()
          return
        }

        requestRefresh()
        startInterval()
      }

      const stopPrimary = primary.subscribe({
        ...subscription,
        onStatusChange,
      })
      reconcileInterval()

      if (pauseWhenHidden && typeof document !== "undefined") {
        document.addEventListener("visibilitychange", onVisibilityChange)
      }

      return () => {
        if (stopped) return
        stopped = true
        stopInterval()
        if (pauseWhenHidden && typeof document !== "undefined") {
          document.removeEventListener("visibilitychange", onVisibilityChange)
        }
        stopPrimary()
      }
    },
  }
}

/** Reason a root exhausted its bounded refresh recovery budget. */
export type RefreshStallReason = "behind" | "missing-axis" | "refresh-error"

/** Freshness lifecycle of the mounted authoritative canon. */
export type FreshnessStatus = "current" | "grace" | "refreshing" | "stalled"

/** Combined freshness and invalidation state exposed by root APIs. */
export interface IncorporationStatus {
  readonly freshness: FreshnessStatus
  readonly invalidations: InvalidationStatus
  readonly missingAxes: readonly AxisId[]
  readonly stallReason: RefreshStallReason | null
}

export { createNoRealtimeInvalidationAdapter } from "./invalidation"
export type {
  AxisInvalidation,
  InvalidationAdapter,
  InvalidationPublisher,
  InvalidationStatus,
  InvalidationSubscription,
} from "./invalidation"

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
  const revisions = {} as Record<AxisId, Revision>

  for (const stamp of accepted.values()) {
    for (const [rawAxis, revision] of Object.entries(stamp.revisions)) {
      const axis = axisId(rawAxis)
      const current = revisionAt(revisions, axis)
      if (current === undefined || revision > current)
        defineCoordinate(revisions, axis, revision)
    }
  }

  for (const [axis, revision] of observed) {
    if (revisionAt(canon.revisions, axis) === undefined) continue
    const current = revisionAt(revisions, axis)
    if (current === undefined || revision > current)
      defineCoordinate(revisions, axis, revision)
  }

  return revisions
}

function missingAxes(
  canon: Canon<unknown>,
  requirements: RevisionVector
): readonly AxisId[] {
  return Object.keys(requirements)
    .map(axisId)
    .filter((axis) => revisionAt(canon.revisions, axis) === undefined)
}

/** Creates the refresh carrier for a snapshot or non-router data source.
 * @param refetch Snapshot refetch operation.
 * @returns A refresh adapter with the snapshot grace policy.
 */
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

/** Imperative incorporation controls shared by predicted and observed roots. */
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
  const scheduledGapRefreshRef = useRef(false)
  const pendingGapRefreshRef = useRef(false)
  const startRefreshRef = useRef<(closeSubscriptionGap?: boolean) => void>(
    () => undefined
  )
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

  const scheduleRefresh = useCallback((closeSubscriptionGap = false) => {
    if (closeSubscriptionGap) scheduledGapRefreshRef.current = true
    if (activeRefreshRef.current) {
      if (closeSubscriptionGap) pendingGapRefreshRef.current = true
      return
    }
    if (scheduledRefreshRef.current) return

    scheduledRefreshRef.current = true
    setRefreshState({ freshness: "refreshing", stallReason: null })
    queueMicrotask(() => {
      scheduledRefreshRef.current = false
      const closesGap = scheduledGapRefreshRef.current
      scheduledGapRefreshRef.current = false
      if (mountedRef.current) startRefreshRef.current(closesGap)
    })
  }, [])

  const completeRefresh = useCallback(
    (failed: boolean) => {
      if (!activeRefreshRef.current || !mountedRef.current) return

      if (failed) failedAttemptsRef.current += 1
      activeRefreshRef.current = false
      activeCompletionRef.current = null
      requestedCanonRef.current = null

      if (pendingGapRefreshRef.current) {
        pendingGapRefreshRef.current = false
        scheduleRefresh(true)
        return
      }

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
    [isCovered, requirements, scheduleRefresh]
  )

  const startRefresh = useCallback(
    (closeSubscriptionGap = false) => {
      if (activeRefreshRef.current) {
        if (closeSubscriptionGap) pendingGapRefreshRef.current = true
        return
      }
      if ((!closeSubscriptionGap && isCovered()) || !mountedRef.current) {
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
    },
    [clearGraceTimer, clearRetryTimer, completeRefresh, isCovered]
  )
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
      const canonRevision = revisionAt(
        canonRef.current.revisions,
        invalidation.axis
      )
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

  const updateInvalidationStatus = useCallback((status: InvalidationStatus) => {
    // Recovery supersedes queued fallback ticks. A real attachment-gap signal
    // follows the active status and schedules its own authoritative refresh.
    if (status === "active") pendingGapRefreshRef.current = false
    setInvalidationStatus(status)
  }, [])

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
      onStatusChange: updateInvalidationStatus,
      onSubscriptionGap: () => scheduleRefresh(true),
    })
  }, [
    invalidations,
    observeInvalidation,
    observedAxes,
    scheduleRefresh,
    updateInvalidationStatus,
  ])

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
