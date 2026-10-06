"use client"

// The predicted-root implementation. Not a package entry: `headcanon/react`
// and `headcanon/next/client` build their public factories on
// `createPredictedRootHook`, and only the Next binding supplies a
// control-flow classifier.
import {
  startTransition,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react"
import { err, ok, type Result } from "serializable-result"

import type { MutationEnvelope, MutationExecutorError } from "./core/authority"
import {
  findMutation,
  type AnyMutationDefinition,
  type MutationContext,
  type MutationDefinition,
  type MutationInvocation,
  type MutationRefusalOf,
  type ProtocolDefinition,
  type ProtocolInvocation,
} from "./core/protocol"
import {
  covers,
  type AcceptedStamp,
  type Canon,
  type RevisionVector,
} from "./core/revisions"
import type {
  DeliveryRecovery,
  FreshnessRecovery,
  MutationLifecycleError,
  MutationReceipt,
  MutationStageListeners,
  PredictedRoot,
  PredictedRootHook,
  PredictedRootOptions,
  PredictedRootRecoveryListeners,
  ProtocolPredictedRoot,
  ReplayConflict,
} from "./react"
import { useIncorporation } from "./refresh"

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

/**
 * A deterministic answer that ends a mutation without acceptance or a domain
 * refusal. `denied` is the authority's private denial. `undeliverable` is an
 * executor refusal of the envelope itself (malformed envelope, arguments that
 * do not parse, a non-canonical invocation, or a reused mutation ID): the
 * authority did nothing, and the same envelope can never succeed.
 */
export type TerminalDeliveryFailure =
  | { readonly kind: "denied" }
  | {
      readonly kind: "undeliverable"
      readonly error: Exclude<
        MutationExecutorError,
        { readonly code: "contention" }
      >
    }

/**
 * The `send` adapter throws this when the authority's answer is final but is
 * neither an accepted stamp nor a domain refusal. The root settles both
 * receipt milestones with the failure, drops the prediction, and moves on to
 * the next queued mutation. It never retries: redelivering the same envelope
 * would get the same answer.
 */
export class TerminalDeliveryError extends Error {
  readonly failure: TerminalDeliveryFailure

  constructor(failure: TerminalDeliveryFailure) {
    super(
      failure.kind === "denied"
        ? "the mutation authority denied the mutation"
        : `the mutation executor refused the envelope: ${failure.error.code}`
    )
    this.name = "TerminalDeliveryError"
    this.failure = failure
  }
}

/**
 * How long one delivery attempt may keep its React Action open. After this
 * wait the root reports `delivery: "uncertain"`, releases the Action, and
 * keeps the envelope for an exact-envelope retry; a response that arrives
 * later still settles the mutation.
 *
 * This bounds only the root's own Action. It cannot bound work that `send`
 * itself parks in React: a Next Server Action call holds every transition in
 * the app until its HTTP request ends (see `createNextPredictedRoot`).
 */
export const DELIVERY_WAIT_MS = 10_000

/** Redelivery backoff for {@link RetryableDeliveryError} — bounded so persistent
 *  contention degrades to an honest uncertain state instead of hammering. */
const DELIVERY_RETRY_DELAYS_MS = [300, 1000, 3000] as const

/** How many recent replay conflicts a root keeps in `conflicts`. */
const RETAINED_CONFLICTS = 50

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

function noop(): void {}

/**
 * Where one live mutation's delivery stands. Terminal outcomes are not states:
 * they remove the entry from the ledger (see `settle`).
 */
type DeliveryState =
  | { readonly kind: "queued" }
  | { readonly kind: "sending" }
  | { readonly kind: "retry-scheduled" }
  | { readonly kind: "uncertain" }
  | { readonly kind: "accepted"; readonly stamp: AcceptedStamp }

/**
 * The one table of delivery transitions. Acceptance may follow every
 * unaccepted state: a late response to an earlier attempt is still the
 * authority's answer for this mutation ID.
 */
const DELIVERY_TRANSITIONS: Readonly<
  Record<DeliveryState["kind"], readonly DeliveryState["kind"][]>
> = {
  queued: ["sending", "accepted"],
  sending: ["retry-scheduled", "uncertain", "accepted"],
  "retry-scheduled": ["queued", "accepted"],
  uncertain: ["queued", "accepted"],
  accepted: [],
}

interface LedgerEntry<Invocation> {
  readonly envelope: MutationEnvelope<Invocation>
  readonly delivery: DeliveryState
  /** A replay refused this prediction; it no longer renders. */
  readonly conflicted: boolean
}

/**
 * The rendered facts of one root: every live mutation in invocation order,
 * and the most recent replay conflicts. The queue is the unaccepted suffix:
 * delivery is serialized, so accepted entries always precede it.
 */
interface Ledger<Invocation, Error> {
  readonly entries: readonly LedgerEntry<Invocation>[]
  readonly conflicts: readonly ReplayConflict<Invocation, Error>[]
}

/** The facts of one live mutation that never render. */
interface EntryLifetime<Error> {
  readonly accepted: Deferred<
    Result<AcceptedStamp, MutationLifecycleError<Error>>
  >
  readonly canonized: Deferred<Result<void, MutationLifecycleError<Error>>>
  /** Numbers delivery attempts, so a late answer knows whether it is current. */
  attempt: number
  /** Automatic redeliveries consumed after {@link RetryableDeliveryError}s. */
  retryAttempts: number
  /**
   * Holds the current attempt's React Action open. While an Action is open,
   * React parks every transition — including the Server Action's RSC payload
   * — so canon carrying this mutation cannot commit before its acceptance is
   * in the ledger. The hold is released when the attempt is answered or after
   * {@link DELIVERY_WAIT_MS}, whichever comes first: a held Action also
   * freezes every unrelated transition and navigation.
   */
  hold: Deferred<void> | null
  waitTimer: ReturnType<typeof setTimeout> | null
  retryTimer: ReturnType<typeof setTimeout> | null
}

function queueHead<Invocation>(
  entries: readonly LedgerEntry<Invocation>[]
): LedgerEntry<Invocation> | undefined {
  return entries.find((entry) => entry.delivery.kind !== "accepted")
}

/**
 * The one authority for a root's mutation lifecycle: the rendered ledger, the
 * receipts, and the delivery queue. React reads the ledger through
 * `useSyncExternalStore`; every change goes through `advance` (delivery
 * transitions) or `settle` (terminal outcomes).
 */
function createLedgerStore<Invocation, Error>(
  send: (
    envelope: MutationEnvelope<Invocation>
  ) => Promise<Result<AcceptedStamp, Error>>,
  classifyDeliveryError: (error: unknown) => void
) {
  let ledger: Ledger<Invocation, Error> = { entries: [], conflicts: [] }
  const lifetimes = new Map<string, EntryLifetime<Error>>()
  const listeners = new Set<() => void>()
  /** Settles once every delivery attempt sent so far has been answered. */
  let outstanding: Promise<void> = Promise.resolve()
  let active = false

  function publish(next: Ledger<Invocation, Error>): void {
    ledger = next
    for (const listener of listeners) listener()
  }

  function entryFor(mutationId: string): LedgerEntry<Invocation> | undefined {
    return ledger.entries.find(
      (entry) => entry.envelope.mutationId === mutationId
    )
  }

  function replaceEntry(
    mutationId: string,
    change: (entry: LedgerEntry<Invocation>) => LedgerEntry<Invocation>
  ): void {
    publish({
      ...ledger,
      entries: ledger.entries.map((entry) =>
        entry.envelope.mutationId === mutationId ? change(entry) : entry
      ),
    })
  }

  /** Applies one delivery transition; false when the table forbids it. */
  function advance(mutationId: string, next: DeliveryState): boolean {
    const entry = entryFor(mutationId)
    if (
      !entry ||
      !DELIVERY_TRANSITIONS[entry.delivery.kind].includes(next.kind)
    )
      return false
    replaceEntry(mutationId, (current) => ({ ...current, delivery: next }))
    return true
  }

  function clearTimers(lifetime: EntryLifetime<Error>): void {
    if (lifetime.waitTimer !== null) clearTimeout(lifetime.waitTimer)
    if (lifetime.retryTimer !== null) clearTimeout(lifetime.retryTimer)
    lifetime.waitTimer = null
    lifetime.retryTimer = null
  }

  /**
   * The one terminal settlement: release the Action, resolve the receipt
   * milestones, and drop the entry. A failure settles both milestones (an
   * already-resolved acceptance keeps its value); canonization settles only
   * the second.
   */
  function settle(
    mutationId: string,
    result: Result<void, MutationLifecycleError<Error>>
  ): void {
    const lifetime = lifetimes.get(mutationId)
    if (!lifetime) return
    lifetimes.delete(mutationId)
    clearTimers(lifetime)
    lifetime.hold?.resolve()
    if (!result.ok) lifetime.accepted.resolve(err(result.error))
    lifetime.canonized.resolve(result)
    publish({
      ...ledger,
      entries: ledger.entries.filter(
        (entry) => entry.envelope.mutationId !== mutationId
      ),
    })
  }

  function receiveOutcome(
    mutationId: string,
    attempt: number,
    hold: Deferred<void>,
    outcome: Result<AcceptedStamp, Error>
  ): void {
    const lifetime = lifetimes.get(mutationId)
    const entry = entryFor(mutationId)
    if (lifetime && entry && entry.delivery.kind !== "accepted") {
      if (attempt === lifetime.attempt && lifetime.waitTimer !== null) {
        clearTimeout(lifetime.waitTimer)
        lifetime.waitTimer = null
      }
      if (outcome.ok) {
        advance(mutationId, { kind: "accepted", stamp: outcome.value })
        lifetime.accepted.resolve(ok(outcome.value))
      } else {
        settle(mutationId, err({ kind: "domain", error: outcome.error }))
      }
    }
    // After the ledger records the answer: canon parked behind this Action
    // can only commit once the projection already accounts for it.
    hold.resolve()
  }

  function receiveThrow(
    mutationId: string,
    attempt: number,
    hold: Deferred<void>,
    error: unknown
  ): void {
    const lifetime = lifetimes.get(mutationId)
    const entry = entryFor(mutationId)
    if (!lifetime || !entry || entry.delivery.kind === "accepted") {
      hold.resolve()
      return
    }

    try {
      classifyDeliveryError(error)
    } catch (controlFlow) {
      // Framework control flow (a redirect, say) must reach the framework.
      // The attempt's Action carries it; once that Action has been
      // released, a fresh transition does.
      if (hold.settled) {
        startTransition(() => {
          throw controlFlow
        })
      } else {
        hold.reject(controlFlow)
      }
      settle(mutationId, err({ kind: "delivery-cancelled" }))
      return
    }

    if (error instanceof TerminalDeliveryError) {
      settle(mutationId, err(error.failure))
      hold.resolve()
      return
    }

    // Only the current attempt's failure is news. An earlier attempt that
    // failed after it was superseded tells nothing about the retry.
    if (attempt === lifetime.attempt && entry.delivery.kind === "sending") {
      if (lifetime.waitTimer !== null) clearTimeout(lifetime.waitTimer)
      lifetime.waitTimer = null
      const retryDelay =
        error instanceof RetryableDeliveryError
          ? DELIVERY_RETRY_DELAYS_MS[lifetime.retryAttempts]
          : undefined
      if (retryDelay === undefined) {
        // An ordinary throw (the commit may exist) or a spent redelivery
        // budget: keep the envelope as honestly uncertain.
        advance(mutationId, { kind: "uncertain" })
      } else {
        // A known-clean miss: redeliver the same envelope after a bounded
        // backoff. The entry stays at the queue head, so order holds.
        lifetime.retryAttempts += 1
        advance(mutationId, { kind: "retry-scheduled" })
        lifetime.retryTimer = setTimeout(() => {
          lifetime.retryTimer = null
          advance(mutationId, { kind: "queued" })
        }, retryDelay)
      }
    }
    hold.resolve()
  }

  function expireAttempt(mutationId: string, attempt: number): void {
    const lifetime = lifetimes.get(mutationId)
    if (!lifetime || lifetime.attempt !== attempt) return
    lifetime.waitTimer = null
    if (advance(mutationId, { kind: "uncertain" })) lifetime.hold?.resolve()
  }

  /** Sends whatever is still unsent and settles every receipt as unmounted. */
  function dispose(): void {
    // Unmount ends this root's ability to *observe* an outcome; it does not
    // repeal the user's intent. An envelope that never reached the authority
    // — typically a debounced autosave flushed from a leaf's unmount
    // cleanup, where the leaf tears down before the provider — is sent
    // fire-and-forget on the way down, after every attempt already in flight
    // has been answered, so two edits to one field keep their order. The
    // canonical envelope and durable mutation ID make the send
    // effectively-once at the authority.
    //
    // A `sending` or `uncertain` entry may already have committed; its
    // receipt, not a second send, is what would resolve it.
    const unsent = ledger.entries.filter(
      (entry) =>
        entry.delivery.kind === "queued" ||
        entry.delivery.kind === "retry-scheduled"
    )
    void unsent.reduce(
      (chain, entry) => chain.then(() => send(entry.envelope)).then(noop, noop),
      outstanding
    )

    for (const entry of ledger.entries) {
      const lifetime = lifetimes.get(entry.envelope.mutationId)
      if (!lifetime) continue
      clearTimers(lifetime)
      lifetime.hold?.resolve()
      // `unknown` stays honest for a farewell send: it left, but no mounted
      // root remains to learn whether the authority accepted it.
      const unmounted = err({
        kind: "root-unmounted",
        outcome: entry.delivery.kind === "accepted" ? "accepted" : "unknown",
      } as const)
      lifetime.accepted.resolve(unmounted)
      lifetime.canonized.resolve(unmounted)
    }
    lifetimes.clear()
    publish({ entries: [], conflicts: ledger.conflicts })
  }

  return {
    getSnapshot: (): Ledger<Invocation, Error> => ledger,

    /** Stamps of the accepted entries, by mutation ID: the refresh requirements. */
    getAccepted(): ReadonlyMap<string, AcceptedStamp> {
      const accepted = new Map<string, AcceptedStamp>()
      for (const entry of ledger.entries) {
        if (entry.delivery.kind === "accepted") {
          accepted.set(entry.envelope.mutationId, entry.delivery.stamp)
        }
      }
      return accepted
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    /** Records one predicted mutation at the end of the queue. */
    enqueue(envelope: MutationEnvelope<Invocation>): MutationReceipt<Error> {
      const lifetime: EntryLifetime<Error> = {
        accepted: createDeferred(),
        canonized: createDeferred(),
        attempt: 0,
        retryAttempts: 0,
        hold: null,
        waitTimer: null,
        retryTimer: null,
      }
      lifetimes.set(envelope.mutationId, lifetime)
      publish({
        ...ledger,
        entries: [
          ...ledger.entries,
          { envelope, delivery: { kind: "queued" }, conflicted: false },
        ],
      })
      return {
        id: envelope.mutationId,
        accepted: lifetime.accepted.promise,
        canonized: lifetime.canonized.promise,
      }
    },

    /** Starts one bounded delivery attempt when the queue head is queued. */
    deliverHead(): void {
      const head = queueHead(ledger.entries)
      if (!active || head?.delivery.kind !== "queued") return
      const mutationId = head.envelope.mutationId
      const lifetime = lifetimes.get(mutationId)
      if (!lifetime || !advance(mutationId, { kind: "sending" })) return

      const attempt = ++lifetime.attempt
      const hold = createDeferred<void>()
      lifetime.hold = hold
      startTransition(() => hold.promise)
      lifetime.waitTimer = setTimeout(
        () => expireAttempt(mutationId, attempt),
        DELIVERY_WAIT_MS
      )

      let delivery: Promise<Result<AcceptedStamp, Error>>
      try {
        delivery = send(head.envelope)
      } catch (error) {
        delivery = Promise.reject(error)
      }
      outstanding = Promise.all([outstanding, delivery.then(noop, noop)]).then(
        noop
      )
      void delivery.then(
        (outcome) => receiveOutcome(mutationId, attempt, hold, outcome),
        (error: unknown) => receiveThrow(mutationId, attempt, hold, error)
      )
    },

    /** Re-queues an uncertain head with a fresh automatic-redelivery budget. */
    retryDelivery(): void {
      const head = queueHead(ledger.entries)
      if (head?.delivery.kind !== "uncertain") return
      const lifetime = lifetimes.get(head.envelope.mutationId)
      if (lifetime) lifetime.retryAttempts = 0
      advance(head.envelope.mutationId, { kind: "queued" })
    },

    /**
     * Records a replay refusal once per mutation. An envelope that has not
     * reached the authority is retracted; one that may have committed keeps
     * waiting for its receipt.
     * @returns The new conflict, or `null` when it was already recorded.
     */
    recordConflict(
      mutationId: string,
      error: Error
    ): ReplayConflict<Invocation, Error> | null {
      const entry = entryFor(mutationId)
      if (!entry || entry.conflicted) return null

      const conflict = {
        mutationId,
        invocation: entry.envelope.invocation,
        error,
      }
      publish({
        entries: ledger.entries.map((current) =>
          current === entry ? { ...current, conflicted: true } : current
        ),
        conflicts: [...ledger.conflicts, conflict].slice(-RETAINED_CONFLICTS),
      })
      if (
        entry.delivery.kind === "queued" ||
        entry.delivery.kind === "retry-scheduled"
      ) {
        settle(mutationId, err({ kind: "replay-refused", error }))
      }
      return conflict
    },

    /** Settles canonization for every accepted entry the canon covers. */
    canonize(revisions: RevisionVector): void {
      for (const entry of ledger.entries) {
        if (
          entry.delivery.kind === "accepted" &&
          covers(revisions, entry.delivery.stamp.revisions)
        ) {
          settle(entry.envelope.mutationId, ok(undefined))
        }
      }
    },

    activate(): void {
      active = true
    },

    /**
     * Disposes at the next microtask unless reactivated first, so a Strict
     * Mode effect replay does not end the root.
     */
    deactivate(): void {
      active = false
      queueMicrotask(() => {
        if (!active) dispose()
      })
    },
  }
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
