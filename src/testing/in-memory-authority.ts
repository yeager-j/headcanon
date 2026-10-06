import { ok, type Result } from "serializable-result"

import {
  contentionRetry,
  createStampAccumulator,
  mutationReceipt,
  receiptKey,
  recordTerminalOutcome,
  replayReceipt,
  throwMutationContention,
  type MutationAttemptFailure,
  type MutationAuthorityAdapter,
  type MutationAuthorityAdapterError,
  type MutationAuthorityRequest,
  type MutationReceipt,
  type MutationTerminalOutcome,
  type StampAccumulator,
} from "../core/authority"

/** Read access to the in-memory authority's state cell. */
export interface InMemoryReader<State> {
  read(): State
}

/** The state cell one in-memory authority attempt reads and writes. */
export interface InMemoryTransaction<State> extends InMemoryReader<State> {
  write(next: State): void
}

/** In-memory authority surface used by contract fixtures and package consumers. */
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
  receiptCount(): number
  hasReceipt(actor: Actor, mutationId: string): boolean
}

/**
 * Creates an effectively-once in-memory authority for tests and local
 * fixtures. It has no test-framework dependency, so it can run in any test
 * runner or in a Next server module.
 *
 * It follows the same authority rules as the Drizzle adapter: receipts are
 * keyed by actor scope and mutation ID, and executions for one key run one at
 * a time while different keys interleave; refusals need the request's
 * `parseRefusal` (without one they throw); and a command that throws
 * `MutationContentionError` reruns from fresh state up to `maxAttempts`.
 * Each attempt gets an isolated copy of the state and its own stamp
 * accumulator. An attempt that wrote state commits only if no other commit
 * landed since it began; otherwise it reruns, like a serialization failure.
 * @param options Initial state, actor scope, cloning, and retry policy.
 * @returns An isolated in-memory mutation authority.
 * @throws Error when `maxAttempts` is not a positive integer.
 */
export function createInMemoryMutationAuthority<
  State,
  Actor,
  Refusal,
>(options: {
  readonly initialState: State
  readonly scope: (actor: Actor) => string
  readonly clone?: (value: State) => State
  readonly maxAttempts?: number
}): InMemoryMutationAuthority<State, Actor, Refusal> {
  const clone = options.clone ?? ((value: State) => structuredClone(value))
  const retry = contentionRetry({ maxAttempts: options.maxAttempts })

  let state = clone(options.initialState)
  let version = 0
  const receipts = new Map<string, MutationReceipt>()
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

    const { stored, terminal } = recordTerminalOutcome(
      attempted,
      stamp,
      request.parseRefusal
    )
    if (attempted.ok && wrote) {
      if (version !== startedAt) throwMutationContention()
      commit(draft)
    }
    receipts.set(key, mutationReceipt(request, stored))
    return ok(terminal)
  }

  return {
    preflight: { read: () => clone(state) },
    execute(request, run) {
      const key = receiptKey(options.scope(request.actor), request.mutationId)
      return withReceiptLock(key, async () => {
        const recorded = receipts.get(key)
        if (recorded) return replayReceipt(recorded, request)
        return retry(request.mutationId, () => attempt(key, request, run))
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
