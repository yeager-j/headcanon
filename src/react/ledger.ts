"use client"

// The mutation ledger of one predicted root: the delivery queue, the receipts,
// and the replay conflicts. Not a package entry; `./predicted-root` mounts one
// store per root and renders its snapshot.
import { startTransition } from "react"
import { err, ok, type Result } from "serializable-result"

import type { MutationEnvelope, MutationExecutorError } from "../core/authority"
import {
  covers,
  type AcceptedStamp,
  type RevisionVector,
} from "../core/revisions"

/** Terminal lifecycle failures surfaced by a predicted root's receipts. */
export type MutationLifecycleError<Error> =
  /** The authority refused the mutation. */
  | { readonly kind: "domain"; readonly error: Error }
  /**
   * Newer canon refused the prediction before the authority stored it, so
   * the mutation was withdrawn.
   */
  | { readonly kind: "replay-refused"; readonly error: Error }
  /**
   * `send` threw framework control flow, such as a redirect, which the root
   * passed on to the framework.
   */
  | { readonly kind: "delivery-cancelled" }
  /** The authority's answer is final but is not a domain refusal. */
  | TerminalDeliveryFailure
  /** The root unmounted before the mutation settled. */
  | {
      readonly kind: "root-unmounted"
      /**
       * `accepted` only when acceptance arrived before unmount; otherwise
       * the authority's answer is unknown.
       */
      readonly outcome: "unknown" | "accepted"
    }

/** Independent acceptance and canonization milestones for one mutation. */
export interface MutationReceipt<Error> {
  /** The mutation ID the authority deduplicates by. */
  readonly id: string
  /**
   * Resolves when the authority accepts or refuses, or the mutation ends
   * without an answer. Never rejects.
   */
  readonly accepted: Promise<
    Result<AcceptedStamp, MutationLifecycleError<Error>>
  >
  /**
   * Resolves ok once this root's canon covers the accepted stamp; otherwise
   * resolves with the same failure as `accepted`, or `root-unmounted`. Never
   * rejects.
   */
  readonly canonized: Promise<Result<void, MutationLifecycleError<Error>>>
}

/** A pending invocation jossed while replaying newer authoritative canon. */
export interface ReplayConflict<Invocation, Error> {
  /** The refused mutation's ID, the same as its receipt's `id`. */
  readonly mutationId: string
  /** The refused invocation. */
  readonly invocation: Invocation
  /** The error the prediction returned on newer canon. */
  readonly error: Error
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
  /** The final answer; both receipt milestones settle with it. */
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
export const DELIVERY_RETRY_DELAYS_MS = [300, 1000, 3000] as const

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

/**
 * The envelope waits for its next delivery attempt. A retried uncertain
 * envelope waits too, though its earlier attempt may have committed.
 */
function awaitsDelivery(delivery: DeliveryState): boolean {
  return delivery.kind === "queued" || delivery.kind === "retry-scheduled"
}

export interface LedgerEntry<Invocation> {
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
   * An attempt became uncertain, so a commit may exist. Retry re-queues the
   * envelope but never clears this.
   */
  mayHaveCommitted: boolean
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

export function queueHead<Invocation>(
  entries: readonly LedgerEntry<Invocation>[]
): LedgerEntry<Invocation> | undefined {
  return entries.find((entry) => entry.delivery.kind !== "accepted")
}

/** Canon covers this entry's accepted stamp: the entry is canonized and no longer predicts. */
export function isCanonized(
  entry: LedgerEntry<unknown>,
  revisions: RevisionVector
): boolean {
  return (
    entry.delivery.kind === "accepted" &&
    covers(revisions, entry.delivery.stamp.revisions)
  )
}

/**
 * The one authority for a root's mutation lifecycle: the rendered ledger, the
 * receipts, and the delivery queue. React reads the ledger through
 * `useSyncExternalStore`; every change goes through `advance` (delivery
 * transitions) or `settle` (terminal outcomes).
 */
export function createLedgerStore<Invocation, Error>(
  send: (
    envelope: MutationEnvelope<Invocation>
  ) => Promise<Result<AcceptedStamp, Error>>,
  rethrowControlFlow: (error: unknown) => void
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
      rethrowControlFlow(error)
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
        markUncertain(mutationId, lifetime)
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

  function markUncertain(
    mutationId: string,
    lifetime: EntryLifetime<Error>
  ): boolean {
    if (!advance(mutationId, { kind: "uncertain" })) return false
    lifetime.mayHaveCommitted = true
    return true
  }

  function expireAttempt(mutationId: string, attempt: number): void {
    const lifetime = lifetimes.get(mutationId)
    if (!lifetime || lifetime.attempt !== attempt) return
    lifetime.waitTimer = null
    if (markUncertain(mutationId, lifetime)) lifetime.hold?.resolve()
  }

  /**
   * Sends each envelope in order once every attempt already in flight has
   * been answered, ignoring every outcome.
   */
  async function sendInOrder(
    envelopes: readonly MutationEnvelope<Invocation>[]
  ): Promise<void> {
    await outstanding
    for (const envelope of envelopes) {
      try {
        await send(envelope)
      } catch {
        // No mounted root remains to observe a farewell send.
      }
    }
  }

  /** Sends every envelope awaiting delivery and settles every receipt as unmounted. */
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
    const awaiting = ledger.entries.filter((entry) =>
      awaitsDelivery(entry.delivery)
    )
    void sendInOrder(awaiting.map((entry) => entry.envelope))

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
        mayHaveCommitted: false,
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
     * Records a replay refusal once per mutation. An envelope that never
     * reached the authority is retracted; one that may have committed, even
     * when retried and queued again, keeps waiting for its receipt.
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
      const lifetime = lifetimes.get(mutationId)
      if (awaitsDelivery(entry.delivery) && !lifetime?.mayHaveCommitted) {
        settle(mutationId, err({ kind: "replay-refused", error }))
      }
      return conflict
    },

    /** Settles canonization for every accepted entry the canon covers. */
    canonize(revisions: RevisionVector): void {
      for (const entry of ledger.entries) {
        if (isCanonized(entry, revisions)) {
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
