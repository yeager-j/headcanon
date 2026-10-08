import { ok, type Result } from "serializable-result"

import {
  checkDeliveryAge,
  contentionRetry,
  createStampAccumulator,
  deliveryAgePolicy,
  prepareTerminalOutcome,
  receiptKey,
  replayReceipt,
  storedReceipt,
  throwMutationContention,
  type MutationAttemptFailure,
  type MutationAuthorityAdapter,
  type MutationAuthorityAdapterError,
  type MutationAuthorityRequest,
  type MutationTerminalOutcome,
  type StampAccumulator,
  type StoredReceipt,
} from "../core/authority"

/** Read access to the in-memory authority's state cell. */
export interface InMemoryReader<State> {
  /** Returns a copy of the state; changing the copy changes nothing. */
  read(): State
}

/** The state cell one in-memory authority attempt reads and writes. */
export interface InMemoryTransaction<State> extends InMemoryReader<State> {
  /**
   * Replaces this attempt's state with a copy of `next`. It commits only if
   * the attempt is accepted and no other commit landed since the attempt
   * began.
   */
  write(next: State): void
}

/**
 * The authority `createInMemoryMutationAuthority` returns: a mutation
 * authority adapter plus controls for tests.
 */
export interface InMemoryMutationAuthority<
  State,
  Actor,
  Refusal,
> extends MutationAuthorityAdapter<
  InMemoryTransaction<State>,
  Actor,
  Refusal,
  InMemoryReader<State>
> {
  /** Reads committed state. */
  read(): State
  /** Commits `next` outside any attempt, as another writer would. */
  replace(next: State): void
  /**
   * Commits `update` concurrently with the next attempt, after its command
   * returns or throws. If that attempt wrote state, it loses the race: its
   * writes and stamp are discarded and the command reruns, as it would after
   * a thrown contention. Every queued update is consumed by exactly one
   * attempt, whatever the attempt's outcome.
   */
  contendNext(update?: (current: State) => State): void
  /** Number of recorded receipts. */
  receiptCount(): number
  /** Whether a receipt is recorded for `mutationId` in `actor`'s scope. */
  hasReceipt(actor: Actor, mutationId: string): boolean
}

/**
 * Creates an in-memory {@link MutationAuthorityAdapter} for tests and local
 * fixtures. It has no test-framework dependency, so it runs in any test runner
 * or in a Next server module. Each attempt gets an isolated copy of the state;
 * an attempt that wrote state commits only if no other commit landed since it
 * began, otherwise it reruns like a serialization failure. Before each
 * attempt it checks the delivery window against `Date.now()`, so fake timers
 * that set the system time control it.
 * @param options The initial state, actor scope, and optional copy, retry,
 *   and delivery-window policy.
 * @returns An isolated in-memory mutation authority.
 * @throws Error when `maxAttempts`, `maxDeliveryAgeMs`, or `clockSkewToleranceMs` is invalid.
 */
export function createInMemoryMutationAuthority<
  State,
  Actor,
  Refusal,
>(options: {
  /** State before any commit. */
  readonly initialState: State
  /** Maps a trusted actor to its receipt scope. */
  readonly scope: (actor: Actor) => string
  /**
   * Copies state wherever it enters or leaves the authority, so no caller
   * shares a reference. Defaults to `structuredClone`.
   */
  readonly clone?: (value: State) => State
  /** Attempts per mutation before it returns `contention`. Defaults to 2. */
  readonly maxAttempts?: number
  /**
   * Oldest `createdAt` a new execution accepts, in milliseconds before now.
   * A positive safe integer; defaults to 7 days.
   */
  readonly maxDeliveryAgeMs?: number
  /**
   * How far `createdAt` may be ahead of now, in milliseconds. A non-negative
   * safe integer; defaults to 1 hour.
   */
  readonly clockSkewToleranceMs?: number
}): InMemoryMutationAuthority<State, Actor, Refusal> {
  const clone = options.clone ?? ((value: State) => structuredClone(value))
  const retry = contentionRetry({ maxAttempts: options.maxAttempts })
  const deliveryAge = deliveryAgePolicy(options)

  let state = clone(options.initialState)
  let version = 0
  const receipts = new Map<string, StoredReceipt>()
  const receiptLocks = new Map<string, Promise<void>>()
  const contention = new Array<(current: State) => State>()

  const commit = (next: State) => {
    state = next
    version += 1
  }

  const withReceiptLock = async <Value>(
    key: string,
    run: () => Promise<Value>
  ): Promise<Value> => {
    const previous = receiptLocks.get(key) ?? Promise.resolve()
    const current = previous.then(run)
    const settled = current.then(
      () => undefined,
      () => undefined
    )
    receiptLocks.set(key, settled)
    try {
      return await current
    } finally {
      if (receiptLocks.get(key) === settled) receiptLocks.delete(key)
    }
  }

  const attempt = async (
    key: string,
    request: MutationAuthorityRequest<Actor, Refusal>,
    run: (
      tx: InMemoryTransaction<State>,
      stamp: StampAccumulator
    ) => Promise<Result<void, MutationAttemptFailure<Refusal>>>
  ): Promise<
    Result<MutationTerminalOutcome<Refusal>, MutationAuthorityAdapterError>
  > => {
    const startedAt = version
    let draft = clone(state)
    let wrote = false
    const tx: InMemoryTransaction<State> = {
      read: () => clone(draft),
      write(next) {
        draft = clone(next)
        wrote = true
      },
    }
    const stamp = createStampAccumulator()
    const concurrentUpdate = contention.shift()

    let attempted: Result<void, MutationAttemptFailure<Refusal>>
    try {
      attempted = await run(tx, stamp)
    } finally {
      if (concurrentUpdate) commit(clone(concurrentUpdate(clone(state))))
    }

    const { stored, terminal } = prepareTerminalOutcome(
      attempted,
      stamp,
      request.parseRefusal
    )
    if (attempted.ok && wrote) {
      if (version !== startedAt) throwMutationContention()
      commit(draft)
    }
    receipts.set(key, storedReceipt(request, stored))
    return ok(terminal)
  }

  return {
    preflight: { read: () => clone(state) },
    execute(request, run) {
      const key = receiptKey(options.scope(request.actor), request.mutationId)
      return withReceiptLock(key, async () => {
        const recorded = receipts.get(key)
        if (recorded) return replayReceipt(recorded, request)

        return retry(request.mutationId, async () => {
          const admitted = checkDeliveryAge(deliveryAge, request, Date.now())
          if (!admitted.ok) return admitted

          return attempt(key, request, run)
        })
      })
    },
    read: () => clone(state),
    replace(next) {
      commit(clone(next))
    },
    contendNext(update = (current) => current) {
      contention.push(update)
    },
    receiptCount: () => receipts.size,
    hasReceipt(actor, mutationId) {
      return receipts.has(receiptKey(options.scope(actor), mutationId))
    },
  }
}
