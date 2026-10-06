"use client"

import {
  startTransition,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react"

import type {
  AxisInvalidation,
  InvalidationAdapter,
  InvalidationStatus,
} from "./invalidation"
import {
  covers,
  revisionAt,
  revisionEntries,
  revisionVectorFrom,
  type AcceptedStamp,
  type AxisId,
  type Canon,
  type RevisionVector,
} from "./revisions"

/** Grace period used by snapshot carriers before an acceptance refresh. */
export const SNAPSHOT_ACCEPTANCE_GRACE_MS = 0
/** Delay before retrying a refresh that completed without meeting the root's requirements. */
export const UNCOVERED_REFRESH_RETRY_MS = 1_000
/** Refresh attempts a requirement gets before the root reports a stall. */
const REFRESH_ATTEMPT_LIMIT = 2

/**
 * Refresh carrier used to obtain a newer authoritative canon.
 *
 * The root runs at most one `request()` at a time, and how an attempt
 * completes depends on what `request()` returns:
 *
 * - A promise: the attempt completes when it settles. Fulfilment is a
 *   delivered refresh; rejection is a failed one.
 * - Nothing (a void carrier such as `router.refresh()`): the attempt completes
 *   when the root next receives a canon whose state value (compared by
 *   identity) or revisions differ from the canon it had when the request
 *   started. A re-render with the same canon, or with a new canon object
 *   around the same state and revisions, does not count, so a parent that
 *   rebuilds the canon wrapper on every render does not consume attempts. The
 *   carrier must deliver a new state object or new revisions, as an RSC
 *   payload does. A void carrier has no failure signal: an attempt that never
 *   receives such a canon stays `refreshing`.
 *
 * A synchronous throw from `request()` is a failed attempt.
 */
export interface RefreshAdapter {
  /** Milliseconds to wait after an acceptance before requesting, so canon that travels with the acceptance can arrive first. */
  readonly acceptanceGraceMs: number
  /** Starts one refresh. See the interface for how the attempt completes. */
  request(): void | Promise<void>
}

/** Reason a root exhausted its bounded refresh recovery budget. */
export type RefreshStallReason = "behind" | "missing-axis" | "refresh-error"

/** Freshness lifecycle of the mounted authoritative canon. */
export type FreshnessStatus = "current" | "grace" | "refreshing" | "stalled"

/**
 * Freshness of the mounted canon. Only the `stalled` state carries a
 * `stallReason`, so a current root with a stall reason cannot be expressed.
 */
export type FreshnessState =
  | { readonly freshness: Exclude<FreshnessStatus, "stalled"> }
  | { readonly freshness: "stalled"; readonly stallReason: RefreshStallReason }

/** Combined freshness and invalidation state exposed by root APIs. */
export type IncorporationStatus = FreshnessState & {
  readonly invalidations: InvalidationStatus
  /** Required axes the mounted canon does not carry at all. */
  readonly missingAxes: readonly AxisId[]
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

// ---------------------------------------------------------------------------
// State machine. Pure: every decision about requirements, attempts, budget,
// and freshness is made here, from the state and one event.

/** What starts the next attempt once it elapses. */
type Wait =
  | { readonly kind: "grace"; readonly ms: number }
  | { readonly kind: "scheduled" }
  | { readonly kind: "retry" }

interface Attempt {
  /** Clock tick when the attempt started; a later gap is not closed by it. */
  readonly startedAt: number
  /** Canon mounted when the attempt started, for void-carrier completion. */
  readonly canon: Canon<unknown>
  readonly awaits: "canon" | "request"
}

interface IncorporationState {
  readonly canon: Canon<unknown>
  /**
   * The acceptance source's stamps, by mutation ID, as of its latest change.
   * Replaced whole on every change; never edited here.
   */
  readonly accepted: ReadonlyMap<string, AcceptedStamp>
  /** Fresher invalidation revisions canon has not yet covered. */
  readonly observed: RevisionVector
  /** Per-axis maximum of `accepted` and `observed`: what canon must cover. */
  readonly required: RevisionVector
  /** Clock tick of the latest subscription gap no refresh has closed yet. */
  readonly gap: number | null
  readonly clock: number
  readonly attempt: Attempt | null
  /** Attempts and failed attempts spent on the current requirements. */
  readonly attempts: number
  readonly failures: number
  /** Pending start of the next attempt. Never set while an attempt runs. */
  readonly wait: Wait | null
  readonly freshness: FreshnessState
  readonly invalidations: InvalidationStatus
}

type IncorporationEvent =
  | {
      readonly type: "acceptances-changed"
      readonly accepted: ReadonlyMap<string, AcceptedStamp>
      readonly graceMs: number
    }
  | { readonly type: "invalidated"; readonly invalidation: AxisInvalidation }
  | { readonly type: "gap-signalled" }
  | { readonly type: "canon-received"; readonly canon: Canon<unknown> }
  | { readonly type: "retry-requested" }
  | { readonly type: "wait-elapsed"; readonly wait: Wait }
  | { readonly type: "request-returned-promise"; readonly startedAt: number }
  | {
      readonly type: "attempt-settled"
      readonly startedAt: number
      readonly failed: boolean
    }
  | {
      readonly type: "invalidation-status"
      readonly status: InvalidationStatus
    }

const CURRENT: FreshnessState = { freshness: "current" }
const GRACE: FreshnessState = { freshness: "grace" }
const REFRESHING: FreshnessState = { freshness: "refreshing" }
const SCHEDULED: Wait = { kind: "scheduled" }
const RETRY: Wait = { kind: "retry" }

function initialState(
  canon: Canon<unknown>,
  invalidations: InvalidationStatus
): IncorporationState {
  const empty = revisionVectorFrom([])
  return {
    canon,
    accepted: new Map(),
    observed: empty,
    required: empty,
    gap: null,
    clock: 0,
    attempt: null,
    attempts: 0,
    failures: 0,
    wait: null,
    freshness: CURRENT,
    invalidations,
  }
}

function missingAxes(
  revisions: RevisionVector,
  required: RevisionVector
): readonly AxisId[] {
  return revisionEntries(required)
    .map(([axis]) => axis)
    .filter((axis) => revisionAt(revisions, axis) === undefined)
}

function sameRevisions(left: RevisionVector, right: RevisionVector): boolean {
  return covers(left, right) && covers(right, left)
}

function withRequirements(
  state: IncorporationState,
  accepted: ReadonlyMap<string, AcceptedStamp>,
  observed: RevisionVector
): IncorporationState {
  const required = revisionVectorFrom([
    ...[...accepted.values()].flatMap((stamp) =>
      revisionEntries(stamp.revisions)
    ),
    ...revisionEntries(observed),
  ])
  return {
    ...state,
    accepted,
    observed,
    // Keeping the reference keeps the published snapshot stable.
    required: sameRevisions(required, state.required)
      ? state.required
      : required,
  }
}

function isMet(state: IncorporationState): boolean {
  return state.gap === null && covers(state.canon.revisions, state.required)
}

/** The one way a root becomes current: requirements met, budget restored. */
function becomeCurrent(state: IncorporationState): IncorporationState {
  return { ...state, attempts: 0, failures: 0, wait: null, freshness: CURRENT }
}

/** New requirements get a fresh budget; a running attempt counts against it. */
function freshBudget(state: IncorporationState): IncorporationState {
  return {
    ...state,
    attempts: state.attempt === null ? 0 : 1,
    failures: 0,
    wait: state.wait?.kind === "retry" ? null : state.wait,
  }
}

/** Starts an attempt at the next microtask unless one runs or is scheduled. */
function refreshSoon(state: IncorporationState): IncorporationState {
  if (state.attempt !== null || state.wait?.kind === "scheduled") {
    return { ...state, freshness: REFRESHING }
  }
  return { ...state, wait: SCHEDULED, freshness: REFRESHING }
}

function stallReason(state: IncorporationState): RefreshStallReason {
  if (state.failures >= REFRESH_ATTEMPT_LIMIT) return "refresh-error"
  return missingAxes(state.canon.revisions, state.required).length > 0
    ? "missing-axis"
    : "behind"
}

/**
 * Whether a canon received while a void request runs is that request's
 * delivery. See {@link RefreshAdapter}.
 */
function deliversNewCanon(
  requested: Canon<unknown>,
  received: Canon<unknown>
): boolean {
  return (
    !Object.is(received.value, requested.value) ||
    !sameRevisions(received.revisions, requested.revisions)
  )
}

function startAttempt(state: IncorporationState): IncorporationState {
  const clock = state.clock + 1
  return {
    ...state,
    clock,
    attempts: state.attempts + 1,
    attempt: { startedAt: clock, canon: state.canon, awaits: "canon" },
    freshness: REFRESHING,
  }
}

function settleAttempt(
  state: IncorporationState,
  startedAt: number,
  failed: boolean
): IncorporationState {
  if (state.attempt?.startedAt !== startedAt) return state

  const closesGap = !failed && state.gap !== null && state.gap < startedAt
  const settled: IncorporationState = {
    ...state,
    attempt: null,
    gap: closesGap ? null : state.gap,
    failures: state.failures + (failed ? 1 : 0),
  }
  if (isMet(settled)) return becomeCurrent(settled)

  if (!failed && covers(settled.canon.revisions, settled.required)) {
    // Only a gap signalled while the attempt ran is left. The attempt could
    // not close it, so it is a new requirement rather than a failed try.
    return refreshSoon(freshBudget(settled))
  }
  if (settled.attempts >= REFRESH_ATTEMPT_LIMIT) {
    return {
      ...settled,
      freshness: { freshness: "stalled", stallReason: stallReason(settled) },
    }
  }
  return { ...settled, wait: RETRY, freshness: REFRESHING }
}

function transition(
  state: IncorporationState,
  event: IncorporationEvent
): IncorporationState {
  switch (event.type) {
    case "acceptances-changed": {
      const added = [...event.accepted.keys()].some(
        (mutationId) => !state.accepted.has(mutationId)
      )
      const removed = [...state.accepted.keys()].some(
        (mutationId) => !event.accepted.has(mutationId)
      )
      if (!added && !removed) return state

      const changed = withRequirements(state, event.accepted, state.observed)
      if (isMet(changed)) return becomeCurrent(changed)
      if (!added) return changed

      // A new acceptance is a new requirement.
      const budgeted = freshBudget(changed)
      if (budgeted.attempt !== null) {
        return { ...budgeted, freshness: REFRESHING }
      }
      if (budgeted.wait !== null) return budgeted
      if (event.graceMs > 0) {
        return {
          ...budgeted,
          wait: { kind: "grace", ms: event.graceMs },
          freshness: GRACE,
        }
      }
      return refreshSoon(budgeted)
    }

    case "invalidated": {
      const { axis, revision } = event.invalidation
      const canonRevision = revisionAt(state.canon.revisions, axis)
      if (canonRevision === undefined || revision <= canonRevision) {
        return state
      }
      // Own writes arrive as invalidations too; an accepted stamp already
      // requires them, so only a revision beyond every requirement is news.
      const requiredRevision = revisionAt(state.required, axis)
      if (requiredRevision !== undefined && revision <= requiredRevision) {
        return state
      }

      const observed = revisionVectorFrom([
        ...revisionEntries(state.observed),
        [axis, revision],
      ])
      return refreshSoon(
        freshBudget(withRequirements(state, state.accepted, observed))
      )
    }

    case "gap-signalled": {
      const clock = state.clock + 1
      // A repeated signal moves the open gap forward without a new budget.
      if (state.gap !== null) return { ...state, clock, gap: clock }
      return refreshSoon(freshBudget({ ...state, clock, gap: clock }))
    }

    case "canon-received": {
      if (event.canon === state.canon) return state

      // An observed revision is no longer required once canon covers it or
      // no longer carries its axis (the root stops observing that axis).
      const stillObserved = revisionEntries(state.observed).filter(
        ([axis, revision]) => {
          const canonRevision = revisionAt(event.canon.revisions, axis)
          return canonRevision !== undefined && canonRevision < revision
        }
      )
      const observed =
        stillObserved.length === revisionEntries(state.observed).length
          ? state.observed
          : revisionVectorFrom(stillObserved)
      const received = withRequirements(
        { ...state, canon: event.canon },
        state.accepted,
        observed
      )
      const { attempt } = received
      if (
        attempt?.awaits === "canon" &&
        deliversNewCanon(attempt.canon, event.canon)
      ) {
        return settleAttempt(received, attempt.startedAt, false)
      }
      return isMet(received) ? becomeCurrent(received) : received
    }

    case "retry-requested":
      return isMet(state)
        ? becomeCurrent(state)
        : refreshSoon(freshBudget(state))

    case "wait-elapsed": {
      if (event.wait !== state.wait) return state
      const elapsed = { ...state, wait: null }
      return isMet(elapsed) ? becomeCurrent(elapsed) : startAttempt(elapsed)
    }

    case "request-returned-promise":
      return state.attempt?.startedAt === event.startedAt
        ? { ...state, attempt: { ...state.attempt, awaits: "request" } }
        : state

    case "attempt-settled":
      return settleAttempt(state, event.startedAt, event.failed)

    case "invalidation-status":
      return state.invalidations === event.status
        ? state
        : { ...state, invalidations: event.status }
  }
}

// ---------------------------------------------------------------------------
// Runtime. Runs the machine's waits and attempts and publishes snapshots. It
// owns timers and the carrier call; it makes no decisions of its own.

interface IncorporationSnapshot {
  readonly freshness: FreshnessState
  readonly invalidations: InvalidationStatus
  readonly required: RevisionVector
}

function snapshotOf(state: IncorporationState): IncorporationSnapshot {
  return {
    freshness: state.freshness,
    invalidations: state.invalidations,
    required: state.required,
  }
}

/**
 * The store that owns a root's accepted mutations: for a predicted root, its
 * ledger. Incorporation requires canon to cover every stamp it lists and keeps
 * no acceptance of its own.
 */
export interface AcceptanceSource {
  /** Stamps of the accepted mutations the root still renders, by mutation ID. */
  readonly getAccepted: () => ReadonlyMap<string, AcceptedStamp>
  /** Calls `listener` synchronously after every change. */
  readonly subscribe: (listener: () => void) => () => void
}

function createIncorporation(
  canon: Canon<unknown>,
  carrier: RefreshAdapter,
  invalidationStatus: InvalidationStatus
) {
  let state = initialState(canon, invalidationStatus)
  let currentCarrier = carrier
  let connected = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let snapshot = snapshotOf(state)
  const listeners = new Set<() => void>()

  const cancelTimer = () => {
    if (timer === null) return
    clearTimeout(timer)
    timer = null
  }

  const arm = (wait: Wait | null) => {
    cancelTimer()
    if (!connected || wait === null) return

    // The machine ignores a wait that is no longer its current one, so a
    // superseded microtask needs no cancellation.
    const elapse = () => {
      if (connected) dispatch({ type: "wait-elapsed", wait })
    }
    if (wait.kind === "scheduled") {
      queueMicrotask(elapse)
      return
    }
    timer = setTimeout(
      elapse,
      wait.kind === "grace" ? wait.ms : UNCOVERED_REFRESH_RETRY_MS
    )
  }

  const run = ({ startedAt }: Attempt) => {
    const settle = (failed: boolean) =>
      dispatch({ type: "attempt-settled", startedAt, failed })

    // A dedicated transition keeps the carrier's navigation work (such as
    // `router.refresh()`) out of urgent updates. Its `isPending` is not used:
    // React 19 entangles it with any open optimistic Action.
    startTransition(async () => {
      let completion: void | Promise<void>
      try {
        completion = currentCarrier.request()
      } catch {
        settle(true)
        return
      }
      if (completion === undefined) return

      dispatch({ type: "request-returned-promise", startedAt })
      try {
        await completion
      } catch {
        settle(true)
        return
      }
      settle(false)
    })
  }

  const publish = () => {
    const next = snapshotOf(state)
    if (
      next.freshness === snapshot.freshness &&
      next.invalidations === snapshot.invalidations &&
      next.required === snapshot.required
    ) {
      return
    }
    snapshot = next
    for (const listener of listeners) listener()
  }

  function dispatch(event: IncorporationEvent) {
    const previous = state
    state = transition(previous, event)
    if (state.wait !== previous.wait) arm(state.wait)
    if (
      state.attempt !== null &&
      state.attempt.startedAt !== previous.attempt?.startedAt
    ) {
      run(state.attempt)
    }
    publish()
  }

  return {
    /** Starts running waits; the returned cleanup stops them. */
    connect() {
      connected = true
      arm(state.wait)
      return () => {
        connected = false
        cancelTimer()
      }
    },
    setCarrier(next: RefreshAdapter) {
      currentCarrier = next
    },
    receiveCanon(next: Canon<unknown>) {
      dispatch({ type: "canon-received", canon: next })
    },
    /**
     * Follows `source` until the returned cleanup runs. Each change reaches
     * the machine inside the source's own notification, before React can
     * render it, so a render never reads acceptances and requirements that
     * disagree.
     */
    followAcceptances(source: AcceptanceSource) {
      const sync = () =>
        dispatch({
          type: "acceptances-changed",
          accepted: source.getAccepted(),
          graceMs: currentCarrier.acceptanceGraceMs,
        })
      sync()
      return source.subscribe(sync)
    },
    retryRefresh() {
      dispatch({ type: "retry-requested" })
    },
    observeInvalidation(invalidation: AxisInvalidation) {
      dispatch({ type: "invalidated", invalidation })
    },
    signalGap() {
      dispatch({ type: "gap-signalled" })
    },
    reportInvalidationStatus(status: InvalidationStatus) {
      dispatch({ type: "invalidation-status", status })
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot() {
      return snapshot
    },
  }
}

// ---------------------------------------------------------------------------
// Hook.

/** Incorporation status and control shared by predicted and observed roots. */
export interface IncorporationCoordinator {
  readonly status: IncorporationStatus
  /** Gives unmet requirements a fresh attempt budget and refreshes now. */
  readonly retryRefresh: () => void
}

/**
 * Keeps one mounted canon fresh: tracks what canon must reach, requests
 * refreshes through the carrier, and reports freshness.
 *
 * Requirements: canon must cover every stamp `acceptances` lists and every
 * invalidation fresher than both canon and those stamps, and every
 * subscription gap must be closed by a successful refresh that started after
 * it. Freshness is `current` exactly when those requirements are met.
 * `acceptances` is the one authority for accepted stamps: the requirements
 * follow each change to it before any render can read that change.
 *
 * Guarantees:
 * - At most one carrier request runs at a time; requests that arrive in the
 *   same tick, or while one runs, coalesce.
 * - An acceptance waits `acceptanceGraceMs` before its first request.
 * - New requirements get a budget of two attempts. An attempt that completes
 *   without meeting them is retried after {@link UNCOVERED_REFRESH_RETRY_MS};
 *   after the second the root reports `stalled` with a reason: `refresh-error`
 *   when both attempts failed, `missing-axis` when canon lacks a required
 *   axis, and `behind` otherwise.
 * - A stall lasts until requirements are met, `retryRefresh()` is called, or
 *   a new requirement arrives (an acceptance, a fresher invalidation, or a
 *   gap while none is open). Accepted predictions stay mounted throughout.
 * - Attempts complete as {@link RefreshAdapter} describes.
 * - The returned functions keep their identity for the mounted lifetime.
 *
 * @param canon Latest authoritative canon the root renders.
 * @param refresh Refresh carrier; the latest one is used for each request.
 * @param invalidations Optional push-invalidation adapter for canon's axes.
 * @param acceptances Optional store of the root's accepted mutations.
 * @returns Incorporation status and the retry control.
 */
export function useIncorporation<State>(
  canon: Canon<State>,
  refresh: RefreshAdapter,
  invalidations?: InvalidationAdapter,
  acceptances?: AcceptanceSource
): IncorporationCoordinator {
  const [incorporation] = useState(() =>
    createIncorporation(
      canon,
      refresh,
      invalidations?.initialStatus ?? "disabled"
    )
  )

  useEffect(() => incorporation.connect(), [incorporation])
  useEffect(() => incorporation.setCarrier(refresh), [incorporation, refresh])
  useEffect(() => incorporation.receiveCanon(canon), [incorporation, canon])
  useEffect(() => {
    if (acceptances) return incorporation.followAcceptances(acceptances)
  }, [acceptances, incorporation])

  const axesKey = JSON.stringify(
    revisionEntries(canon.revisions)
      .map(([axis]) => axis)
      .sort()
  )
  const axes = useMemo(() => JSON.parse(axesKey) as AxisId[], [axesKey])

  useEffect(() => {
    // The adapter's `initialStatus` is the status a subscription made now
    // starts in, so it is read again for every subscription.
    incorporation.reportInvalidationStatus(
      invalidations?.initialStatus ?? "disabled"
    )
    if (!invalidations) return

    return invalidations.subscribe({
      axes,
      onInvalidation: incorporation.observeInvalidation,
      onStatusChange: incorporation.reportInvalidationStatus,
      onSubscriptionGap: incorporation.signalGap,
    })
  }, [axes, incorporation, invalidations])

  const snapshot = useSyncExternalStore(
    incorporation.subscribe,
    incorporation.getSnapshot,
    incorporation.getSnapshot
  )
  const status = useMemo<IncorporationStatus>(
    () => ({
      ...snapshot.freshness,
      invalidations: snapshot.invalidations,
      missingAxes: missingAxes(canon.revisions, snapshot.required),
    }),
    [canon.revisions, snapshot]
  )

  return useMemo(
    () => ({ status, retryRefresh: incorporation.retryRefresh }),
    [incorporation, status]
  )
}
