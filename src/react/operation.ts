"use client"

// The operation hook: one held submission per form instance, delivered with
// one envelope until the server answers. Not a package entry; the Next
// binding (`headcanon/next/client`) supplies its sender.
import {
  startTransition,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useSyncExternalStore,
} from "react"
import { err, ok, type Result } from "serializable-result"

import { parseEnvelope } from "../core/authority"
import {
  canonicalJson,
  type CanonicalInvocationError,
} from "../core/canonical-invocation"
import {
  createOperationEnvelope,
  operationRegistry,
  type AnyOperationDefinition,
  type OperationArgsOf,
  type OperationEnvelope,
  type OperationRefusalOf,
  type OperationResultOf,
} from "../core/operation"
import {
  DELIVERY_RETRY_DELAYS_MS,
  DELIVERY_WAIT_MS,
  RetryableDeliveryError,
  TerminalDeliveryError,
  type TerminalDeliveryFailure,
} from "./ledger"
import { hasValidArguments, type QueuePersistence } from "./persistence"

/**
 * Delivers one operation envelope and returns the server's answer: the
 * accepted result, or the public refusal. It throws
 * `RetryableDeliveryError` when the same envelope should be sent again (the
 * authority's contention), `TerminalDeliveryError` for any other final answer,
 * and anything else when the answer is unknown.
 */
export type OperationSender<Operation extends AnyOperationDefinition> = (
  envelope: OperationEnvelope<Operation>
) => Promise<
  Result<OperationResultOf<Operation>, OperationRefusalOf<Operation>>
>

/** A final failure from the server for one submission. */
export type OperationAnswerFailure<Refusal> =
  /** The command refused the submission. */
  | { readonly kind: "refused"; readonly error: Refusal }
  | (TerminalDeliveryFailure & {
      /**
       * An earlier delivery of this submission may have committed: an
       * attempt threw, outlived `DELIVERY_WAIT_MS`, or was restored after a
       * page load.
       */
      readonly mayHaveCommitted: boolean
    })

/** The server's final answer for one submission: its result, or a failure. */
export type OperationAnswer<Accepted, Refusal> = Result<
  Accepted,
  OperationAnswerFailure<Refusal>
>

/** Why one `run` or `retry` call ended without a final answer from the server. */
export type OperationFailure<Refusal> =
  | OperationAnswerFailure<Refusal>
  /**
   * No answer within `DELIVERY_WAIT_MS`, or the call failed. The submission
   * stays held: call `retry`, or `discard` it. A later answer still settles it.
   */
  | { readonly kind: "unconfirmed"; readonly mayHaveCommitted: boolean }
  /** Other arguments while a submission is held. Nothing was sent. */
  | { readonly kind: "pending-submission" }
  /** `retry` with no held submission and no answer. Nothing was sent. */
  | { readonly kind: "no-submission" }

/** What one `run` or `retry` call returns. */
export type OperationOutcome<Accepted, Refusal> = Result<
  Accepted,
  OperationFailure<Refusal>
>

/**
 * Where an operation hook's submission stands. `sending` waits for an
 * answer; `unconfirmed` holds a submission that has no answer yet, after
 * `DELIVERY_WAIT_MS`, a failed call, or a page load; `settled` has an answer
 * in `outcome`.
 */
export type OperationStatus = "idle" | "sending" | "unconfirmed" | "settled"

/** The submission an operation hook holds until the server answers. */
export interface PendingOperation<Args> {
  /** The submitted arguments, for example to fill the form again after a reload. */
  readonly args: Args
  /** The hook restored the submission from its `persistence` after a page load. */
  readonly restored: boolean
  /** An earlier delivery of this submission may have committed. */
  readonly mayHaveCommitted: boolean
}

/** One form's operation: its status and the calls that submit it. */
export interface OperationHandle<Operation extends AnyOperationDefinition> {
  /** Where the submission stands; see {@link OperationStatus}. */
  readonly status: OperationStatus
  /** The held submission while `sending` or `unconfirmed`. */
  readonly pending: PendingOperation<OperationArgsOf<Operation>> | undefined
  /** The last answer, while `settled`. */
  readonly outcome:
    | OperationAnswer<
        OperationResultOf<Operation>,
        OperationRefusalOf<Operation>
      >
    | undefined
  /**
   * Submits `args` with a new mutation ID, or, when the held submission has
   * the same arguments, retries it. Resolves with the answer, or with
   * `unconfirmed` after at most `DELIVERY_WAIT_MS`. Never rejects, except to
   * pass on framework control flow such as a server `redirect()`.
   */
  run(
    args: OperationArgsOf<Operation>
  ): Promise<
    OperationOutcome<
      OperationResultOf<Operation>,
      OperationRefusalOf<Operation>
    >
  >
  /**
   * Sends the held submission again: the same envelope, mutation ID, and
   * `createdAt`. Joins a delivery still in flight instead of sending twice.
   * Resolves like `run`.
   */
  retry(): Promise<
    OperationOutcome<
      OperationResultOf<Operation>,
      OperationRefusalOf<Operation>
    >
  >
  /**
   * Forgets the held submission, so the next `run` makes a new one. An
   * earlier delivery of it may still commit; its answer no longer changes
   * this hook, and its framework control flow, such as a server
   * `redirect()`, is dropped.
   */
  discard(): void
}

/** Options for one mounted operation hook. */
export interface OperationHookOptions<
  Operation extends AnyOperationDefinition,
> {
  /**
   * The receipt scope of the signed-in actor, as the authority's
   * `scope(actor)` returns it, such as a user ID. `run` puts it in each new
   * submission's envelope; a held or restored submission keeps its own. The
   * action denies a submission whose scope is not the delivering actor's, so
   * one made before a sign-out never runs as the next actor.
   */
  readonly scope: string
  /**
   * Keeps the held submission across a page load, for example
   * `sessionStoragePersistence(\`new-run:${playerId}\`)`. A restored
   * submission is `unconfirmed` and is never sent again on its own. Hooks of
   * one factory with the same key share one submission; use each key with
   * one factory only.
   */
  readonly persistence?: QueuePersistence
  /**
   * Receives each answer once, including one that arrives after `run`
   * resolved `unconfirmed`, or after a page load and `retry`. Navigate here.
   */
  readonly onSettled?: (
    answer: OperationAnswer<
      OperationResultOf<Operation>,
      OperationRefusalOf<Operation>
    >
  ) => void
}

/**
 * The hook an operation hook factory returns. Call it once per form instance.
 * @param options The actor's receipt scope, persistence for the held
 *   submission, and the answer listener.
 * @returns The form's operation handle.
 */
export type OperationHook<Operation extends AnyOperationDefinition> = (
  options: OperationHookOptions<Operation>
) => OperationHandle<Operation>

type AnswerOf<Operation extends AnyOperationDefinition> = OperationAnswer<
  OperationResultOf<Operation>,
  OperationRefusalOf<Operation>
>
type OutcomeOf<Operation extends AnyOperationDefinition> = OperationOutcome<
  OperationResultOf<Operation>,
  OperationRefusalOf<Operation>
>

interface Snapshot<Operation extends AnyOperationDefinition> {
  readonly status: OperationStatus
  readonly pending: PendingOperation<OperationArgsOf<Operation>> | undefined
  readonly outcome: AnswerOf<Operation> | undefined
}

const IDLE: Snapshot<never> = Object.freeze({
  status: "idle",
  pending: undefined,
  outcome: undefined,
})

/** One `run` or `retry` call waiting on a delivery, with its own deadline. */
interface Waiter<Operation extends AnyOperationDefinition> {
  resolve(outcome: OutcomeOf<Operation>): void
  reject(reason: unknown): void
}

/**
 * The calls of one held envelope that are still unanswered: the first send,
 * then each contention resend.
 */
interface Delivery<Operation extends AnyOperationDefinition> {
  readonly waiters: Set<Waiter<Operation>>
  resends: number
}

/** The submission a cell holds until the server answers it. */
interface Held<Operation extends AnyOperationDefinition> {
  readonly envelope: OperationEnvelope<Operation>
  readonly restored: boolean
  mayHaveCommitted: boolean
  delivery: Delivery<Operation> | undefined
  /** Every waiter of the delivery has passed its deadline. */
  waitExpired: boolean
}

/** The submission state one persistence key, or one unpersisted hook, owns. */
interface OperationCell<Operation extends AnyOperationDefinition> {
  getSnapshot(): Snapshot<Operation>
  subscribe(listener: () => void): () => void
  mount(onSettled: (answer: AnswerOf<Operation>) => void): () => void
  run(
    args: OperationArgsOf<Operation>,
    scope: string
  ): Promise<OutcomeOf<Operation>>
  retry(): Promise<OutcomeOf<Operation>>
  discard(): void
}

/**
 * How a cell joins and leaves its factory's cells by key. A cell without a
 * persistence key is never looked up.
 */
interface CellRegistration {
  register(): void
  release(): void
}

const UNREGISTERED_CELL: CellRegistration = {
  register: () => undefined,
  release: () => undefined,
}

/** The one stored envelope of a cell; it never throws. */
interface OperationStorage<Operation extends AnyOperationDefinition> {
  load(): OperationEnvelope<Operation> | undefined
  save(envelope: OperationEnvelope<Operation> | undefined): void
}

/**
 * Wraps `persistence` so that no storage failure reaches the cell. After a
 * failed read the cell never writes: it would replace a submission it could
 * not see.
 */
function createOperationStorage<Operation extends AnyOperationDefinition>(
  persistence: QueuePersistence | undefined,
  operation: Operation
): OperationStorage<Operation> {
  if (!persistence) return { load: () => undefined, save: () => undefined }

  let readFailed = false
  return {
    load() {
      try {
        return parseStoredSubmission(persistence.load(), operation)
      } catch {
        readFailed = true
        return undefined
      }
    },
    save(envelope) {
      if (readFailed) return

      try {
        persistence.save(envelope ? [envelope] : [])
      } catch {
        // Storage is best effort; the submission in memory is complete.
      }
    },
  }
}

/**
 * The submission `stored` holds: a list of exactly one envelope that this
 * operation admits, with arguments in parsed form. Anything else holds none.
 */
function parseStoredSubmission<Operation extends AnyOperationDefinition>(
  stored: unknown,
  operation: Operation
): OperationEnvelope<Operation> | undefined {
  if (!Array.isArray(stored) || stored.length !== 1) return undefined

  const parsed = parseEnvelope(stored[0], operationRegistry(operation))
  if (!parsed.ok || !hasValidArguments(operation.args, parsed.value.args)) {
    return undefined
  }

  return createOperationEnvelope(
    operation,
    parsed.value.args as OperationArgsOf<Operation>,
    parsed.value
  )
}

/** Whether two argument values are one canonical JSON value. */
function sameArguments(left: unknown, right: unknown): boolean {
  const leftJson: Result<string, CanonicalInvocationError> = canonicalJson(left)
  const rightJson = canonicalJson(right)
  return leftJson.ok && rightJson.ok && leftJson.value === rightJson.value
}

function createOperationCell<Operation extends AnyOperationDefinition>(
  operation: Operation,
  send: OperationSender<Operation>,
  rethrowControlFlow: (error: unknown) => void,
  storage: OperationStorage<Operation>,
  registration: CellRegistration
): OperationCell<Operation> {
  let held: Held<Operation> | undefined
  let outcome: AnswerOf<Operation> | undefined
  let undelivered: AnswerOf<Operation> | undefined
  let restored = false
  /** The mounted hooks' answer listeners, in mount order; the last one hears answers. */
  const settledListeners: Array<(answer: AnswerOf<Operation>) => void> = []
  let snapshot: Snapshot<Operation> = IDLE
  const listeners = new Set<() => void>()

  const publish = () => {
    snapshot = Object.freeze({
      status: statusOf(held, outcome),
      pending: held && {
        args: held.envelope.invocation.args,
        restored: held.restored,
        mayHaveCommitted: held.mayHaveCommitted,
      },
      outcome: held ? undefined : outcome,
    })

    for (const listener of listeners) listener()
  }

  const restore = () => {
    if (restored) return
    restored = true

    const envelope = storage.load()
    if (!envelope || held) return
    held = {
      envelope,
      restored: true,
      mayHaveCommitted: true,
      delivery: undefined,
      waitExpired: false,
    }
    publish()
  }

  /** Ends the held submission with the server's answer. */
  const settle = (submission: Held<Operation>, answer: AnswerOf<Operation>) => {
    if (held !== submission) return

    held = undefined
    outcome = answer
    storage.save(undefined)
    publish()

    const listener = settledListeners.at(-1)
    if (listener) listener(answer)
    else undelivered = answer
  }

  /** Ends a held submission the server answered with framework control flow. */
  const release = (submission: Held<Operation>) => {
    if (held !== submission) return

    held = undefined
    storage.save(undefined)
    publish()
  }

  const finishDelivery = (
    submission: Held<Operation>,
    delivery: Delivery<Operation>,
    result: OutcomeOf<Operation>
  ) => {
    for (const waiter of delivery.waiters) waiter.resolve(result)
    delivery.waiters.clear()
    if (submission.delivery === delivery) submission.delivery = undefined
  }

  const answerFailure = (
    submission: Held<Operation>,
    failure: TerminalDeliveryFailure
  ): AnswerOf<Operation> =>
    err({ ...failure, mayHaveCommitted: submission.mayHaveCommitted })

  const sendOnce = (
    submission: Held<Operation>,
    delivery: Delivery<Operation>
  ) => {
    void send(submission.envelope).then(
      (answer) => {
        const result: AnswerOf<Operation> = answer.ok
          ? ok(answer.value)
          : err({ kind: "refused", error: answer.error })
        finishDelivery(submission, delivery, result)
        settle(submission, result)
      },
      (error: unknown) => receiveThrow(submission, delivery, error)
    )
  }

  const receiveThrow = (
    submission: Held<Operation>,
    delivery: Delivery<Operation>,
    error: unknown
  ) => {
    try {
      rethrowControlFlow(error)
    } catch (controlFlow) {
      // A discarded submission's control flow must not navigate, so its
      // waiting calls end unconfirmed. The server answered, so the call may
      // have committed.
      if (held !== submission) {
        submission.mayHaveCommitted = true
        unconfirm(submission, delivery)
        return
      }

      // Framework control flow (a redirect, say) must reach the framework.
      // A waiting `run` or `retry` carries it; once every wait has expired,
      // a fresh transition does, while a hook is mounted to receive it.
      if (delivery.waiters.size > 0) {
        for (const waiter of delivery.waiters) waiter.reject(controlFlow)
        delivery.waiters.clear()
      } else if (settledListeners.length > 0) {
        startTransition(() => {
          throw controlFlow
        })
      }
      release(submission)
      return
    }

    const disposition = classifyThrow(error, delivery.resends)
    if (disposition.kind === "answered") {
      const answer = answerFailure(submission, disposition.failure)
      finishDelivery(submission, delivery, answer)
      settle(submission, answer)
      return
    }

    const owned = held === submission
    if (disposition.kind === "resend" && owned) {
      delivery.resends += 1
      setTimeout(() => {
        if (held === submission) sendOnce(submission, delivery)
        else unconfirm(submission, delivery)
      }, disposition.delayMs)
      return
    }

    if (disposition.kind === "unanswered" && owned) {
      submission.mayHaveCommitted = true
    }

    unconfirm(submission, delivery)
  }

  /** Ends a delivery without an answer; the submission stays held. */
  const unconfirm = (
    submission: Held<Operation>,
    delivery: Delivery<Operation>
  ) => {
    finishDelivery(
      submission,
      delivery,
      err({
        kind: "unconfirmed",
        mayHaveCommitted: submission.mayHaveCommitted,
      })
    )

    if (held === submission) publish()
  }

  /** Waits on `delivery` for at most `DELIVERY_WAIT_MS`. */
  const wait = (
    submission: Held<Operation>,
    delivery: Delivery<Operation>
  ): Promise<OutcomeOf<Operation>> =>
    new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        if (!delivery.waiters.delete(waiter)) return

        // Nothing answered in time, so the call may still commit.
        if (held === submission) {
          submission.mayHaveCommitted = true
          submission.waitExpired = delivery.waiters.size === 0
          publish()
        }
        resolve(
          err({
            kind: "unconfirmed",
            mayHaveCommitted: true,
          })
        )
      }, DELIVERY_WAIT_MS)
      const waiter: Waiter<Operation> = {
        resolve(result) {
          clearTimeout(deadline)
          resolve(result)
        },
        reject(reason) {
          clearTimeout(deadline)
          reject(reason)
        },
      }
      delivery.waiters.add(waiter)
    })

  /** Sends the held submission, or joins its delivery still in flight. */
  const deliver = (submission: Held<Operation>) => {
    const inFlight = submission.delivery
    submission.waitExpired = false
    if (inFlight) {
      const joined = wait(submission, inFlight)
      publish()
      return joined
    }

    const delivery: Delivery<Operation> = { waiters: new Set(), resends: 0 }
    submission.delivery = delivery
    const answered = wait(submission, delivery)
    publish()
    sendOnce(submission, delivery)
    return answered
  }

  const retire = () => {
    if (settledListeners.length === 0 && !held && !undelivered) {
      registration.release()
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    mount(listener) {
      // A remount, such as StrictMode's, follows a cleanup that may have
      // released the cell; register it again so its key finds it.
      registration.register()
      restore()
      settledListeners.push(listener)

      if (undelivered) {
        const answer = undelivered
        undelivered = undefined
        listener(answer)
      }

      return () => {
        settledListeners.splice(settledListeners.indexOf(listener), 1)
        retire()
      }
    },
    run(args, scope) {
      restore()
      if (held) {
        return sameArguments(args, held.envelope.invocation.args)
          ? deliver(held)
          : Promise.resolve(err({ kind: "pending-submission" }))
      }

      held = {
        envelope: createOperationEnvelope(operation, args, { scope }),
        restored: false,
        mayHaveCommitted: false,
        delivery: undefined,
        waitExpired: false,
      }
      outcome = undefined
      storage.save(held.envelope)
      return deliver(held)
    },
    retry() {
      restore()
      if (held) return deliver(held)

      return Promise.resolve(outcome ?? err({ kind: "no-submission" }))
    },
    discard() {
      if (!held) return

      held = undefined
      outcome = undefined
      storage.save(undefined)
      publish()
      retire()
    },
  }
}

/** What a delivery does after its call threw something other than control flow. */
type ThrowDisposition =
  /** The server answered with a final failure. */
  | { readonly kind: "answered"; readonly failure: TerminalDeliveryFailure }
  /** The server wrote nothing and asks for the same envelope again. */
  | { readonly kind: "resend"; readonly delayMs: number }
  /** The server wrote nothing, and the contention backoff is spent. */
  | { readonly kind: "exhausted" }
  /** No answer: the call may have committed. */
  | { readonly kind: "unanswered" }

function classifyThrow(error: unknown, resends: number): ThrowDisposition {
  if (error instanceof TerminalDeliveryError) {
    return { kind: "answered", failure: error.failure }
  }
  if (!(error instanceof RetryableDeliveryError)) return { kind: "unanswered" }

  const delayMs = DELIVERY_RETRY_DELAYS_MS[resends]
  return delayMs === undefined
    ? { kind: "exhausted" }
    : { kind: "resend", delayMs }
}

function statusOf(
  held: Held<AnyOperationDefinition> | undefined,
  outcome: unknown
): OperationStatus {
  if (!held) return outcome === undefined ? "idle" : "settled"
  return held.delivery && !held.waitExpired ? "sending" : "unconfirmed"
}

/**
 * Creates the hook for one operation. Each mounted hook holds one submission:
 * `run` makes an envelope once, and every retry sends that same envelope
 * until the server answers, so the operation's receipt can return the first
 * answer instead of writing twice. Not a package export: use
 * `createNextOperationHook` from `headcanon/next/client`.
 */
export function createOperationHook<Operation extends AnyOperationDefinition>(
  options: {
    readonly operation: Operation
    readonly send: OperationSender<Operation>
  },
  rethrowControlFlow: (error: unknown) => void = () => undefined
): OperationHook<Operation> {
  /** This factory's cells by persistence key, while a hook or a submission needs them. */
  const cells = new Map<string, OperationCell<Operation>>()

  const cellFor = (
    persistence: QueuePersistence | undefined
  ): OperationCell<Operation> => {
    const storage = createOperationStorage(persistence, options.operation)
    const create = (registration: CellRegistration) =>
      createOperationCell(
        options.operation,
        options.send,
        rethrowControlFlow,
        storage,
        registration
      )
    if (!persistence || typeof window === "undefined") {
      return create(UNREGISTERED_CELL)
    }

    const { key } = persistence
    const continued = cells.get(key)
    if (continued) return continued

    const cell: OperationCell<Operation> = create({
      register() {
        if (!cells.has(key)) cells.set(key, cell)
      },
      release() {
        if (cells.get(key) === cell) cells.delete(key)
      },
    })
    cells.set(key, cell)
    return cell
  }

  return function useOperation(hookOptions) {
    const { persistence, scope } = hookOptions
    const key = persistence?.key
    // A new key selects another submission; the store object may change
    // identity on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const cell = useMemo(() => cellFor(persistence), [key])
    const snapshot = useSyncExternalStore(
      cell.subscribe,
      cell.getSnapshot,
      () => IDLE
    )

    const settled = useEffectEvent((answer: AnswerOf<Operation>) =>
      hookOptions.onSettled?.(answer)
    )
    useEffect(() => cell.mount((answer) => settled(answer)), [cell])

    const run = useCallback(
      (args: OperationArgsOf<Operation>) => cell.run(args, scope),
      [cell, scope]
    )
    const retry = useCallback(() => cell.retry(), [cell])
    const discard = useCallback(() => cell.discard(), [cell])

    return useMemo(
      () => ({ ...snapshot, run, retry, discard }),
      [snapshot, run, retry, discard]
    )
  }
}
