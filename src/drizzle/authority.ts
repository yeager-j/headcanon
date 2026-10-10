import { and, asc, eq, lt, sql } from "drizzle-orm"
import {
  type PgDatabase,
  type PgQueryResultHKT,
  type PgTransaction,
} from "drizzle-orm/pg-core"
import type { ExtractTablesWithRelations } from "drizzle-orm/relations"
import { err, ok, type Result } from "serializable-result"

import {
  checkDeliveryAge,
  contentionRetry,
  createStampAccumulator,
  DEFAULT_RECEIPT_CLEANUP_MARGIN_MS,
  deliveryAgePolicy,
  prepareTerminalOutcome,
  receiptKey,
  receiptRetentionMs,
  replayReceipt,
  storedReceipt,
  type MutationAttemptFailure,
  type MutationAuthorityAdapter,
  type StampAccumulator,
  type StoredReceipt,
} from "../core/authority"
import { isPostgresContention } from "./postgres-error"
import { headcanonMutationReceipts } from "./schema"

/**
 * The transaction each command attempt receives from
 * `createDrizzleMutationAuthority`, for a database with this query-result kind
 * and schema. To derive it from a database type, use
 * `DrizzleMutationTx<typeof db>`.
 */
export type DrizzleMutationTransaction<
  QueryResult extends PgQueryResultHKT,
  Schema extends Record<string, unknown>,
> = PgTransaction<QueryResult, Schema, ExtractTablesWithRelations<Schema>>

/**
 * The transaction a mutation command runs inside, derived from the adopter's own
 * Drizzle database type. A binder already types a bound command's `tx`; use
 * this for helpers that take a `tx` and for a standalone `MutationCommand`.
 */
export type DrizzleMutationTx<
  DB extends PgDatabase<PgQueryResultHKT, Record<string, unknown>>,
> = Parameters<Parameters<DB["transaction"]>[0]>[0]

/** Options for `createDrizzleMutationAuthority`. */
export interface DrizzleMutationAuthorityOptions<
  QueryResult extends PgQueryResultHKT,
  Schema extends Record<string, unknown>,
  Actor,
> {
  /**
   * Interactive Postgres client that runs each execution in a transaction, and
   * the `preflight` executor. HTTP-only clients cannot run interactive
   * transactions; for Neon, use the WebSocket `Pool`.
   */
  readonly db: PgDatabase<QueryResult, Schema>
  /**
   * Returns the trusted receipt scope for an actor, such as a user ID.
   * Receipts and duplicate detection are keyed by this scope and the mutation
   * ID, so it must be stable for one actor. The action denies an envelope
   * whose `scope` is not this value, so the client must derive the same one.
   */
  readonly scope: (actor: Actor) => string
  /**
   * Total attempts, including the first, before a contended execution returns
   * `contention`. A positive integer; defaults to 2.
   */
  readonly maxAttempts?: number
  /**
   * Marks an error thrown by an attempt as contention, so the attempt rolls
   * back and reruns. PostgreSQL serialization failure, deadlock, and
   * lock-not-available errors already count. Build it with
   * `matchesPostgresError`.
   */
  readonly isContentionError?: (error: unknown) => boolean
  /**
   * Oldest `createdAt` a new execution accepts, in milliseconds before the
   * database clock. A positive safe integer; defaults to 7 days. Keep it
   * fixed for the receipt table once receipt cleanup runs.
   */
  readonly maxDeliveryAgeMs?: number
  /**
   * How far `createdAt` may be ahead of the database clock, in milliseconds.
   * A non-negative safe integer; defaults to 1 hour. Keep it fixed for the
   * receipt table once receipt cleanup runs.
   */
  readonly clockSkewToleranceMs?: number
}

/** Options for `DrizzleMutationAuthority.deleteExpiredReceipts`. */
export interface DeleteExpiredReceiptsOptions {
  /**
   * Retention beyond the delivery window, in milliseconds, for database clock
   * adjustments. A non-negative safe integer; defaults to 1 hour.
   */
  readonly marginMs?: number
  /** Most receipts one call deletes. A positive safe integer; defaults to 1000. */
  readonly limit?: number
}

/**
 * The mutation authority `createDrizzleMutationAuthority` returns. Pass it to
 * `createMutationBinder`. It can also delete the receipts its own delivery
 * window no longer needs.
 */
export interface DrizzleMutationAuthority<
  QueryResult extends PgQueryResultHKT,
  Schema extends Record<string, unknown>,
  Actor,
  Refusal,
> extends MutationAuthorityAdapter<
  DrizzleMutationTransaction<QueryResult, Schema>,
  Actor,
  Refusal,
  PgDatabase<QueryResult, Schema>
> {
  /**
   * Deletes up to `limit` receipts, oldest first, recorded longer ago than
   * `maxDeliveryAgeMs + clockSkewToleranceMs + marginMs` on the database
   * clock. No redelivery that keeps its envelope's `createdAt` can execute
   * again after its receipt is deleted. Receipts that a delivery has locked
   * are skipped and left for a later call.
   *
   * Every server and cleanup job that uses the receipt table must share one
   * delivery window. Do not call it while a server without the delivery
   * check can still accept deliveries.
   * @returns The number of receipts deleted. Fewer than `limit` means the
   * table had no more unlocked expired receipts at that moment.
   * @throws Error when `marginMs` is not a non-negative safe integer or `limit` is not a positive safe integer.
   * @example
   * ```ts
   * // A scheduled job: delete in batches until a batch comes back short.
   * let deleted: number
   * do {
   *   deleted = await notesAuthority.deleteExpiredReceipts({ limit: 1000 })
   * } while (deleted === 1000)
   * ```
   */
  deleteExpiredReceipts(options?: DeleteExpiredReceiptsOptions): Promise<number>
}

/** Receipts one `deleteExpiredReceipts` call deletes when no `limit` is given. */
const DEFAULT_RECEIPT_CLEANUP_LIMIT = 1000

/** Thrown inside the attempt savepoint so Drizzle rolls back a refused or denied command's writes. */
class AttemptRollback<Refusal> extends Error {
  readonly failure: MutationAttemptFailure<Refusal>

  constructor(failure: MutationAttemptFailure<Refusal>) {
    super("Roll back the refused or denied mutation attempt")
    this.name = "AttemptRollback"
    this.failure = failure
  }
}

/**
 * Runs one command attempt in a savepoint whose writes roll back when the
 * command is refused or denied. An accepted attempt's result is its `ok` value.
 */
async function runAttemptInSavepoint<
  QueryResult extends PgQueryResultHKT,
  Schema extends Record<string, unknown>,
  Refusal,
>(
  tx: DrizzleMutationTransaction<QueryResult, Schema>,
  run: (
    tx: DrizzleMutationTransaction<QueryResult, Schema>,
    stamp: StampAccumulator
  ) => Promise<Result<unknown, MutationAttemptFailure<Refusal>>>,
  stamp: StampAccumulator
): Promise<Result<unknown, MutationAttemptFailure<Refusal>>> {
  try {
    const result = await tx.transaction(async (attemptTx) => {
      const attempted = await run(attemptTx, stamp)
      if (!attempted.ok) throw new AttemptRollback(attempted.error)

      return attempted.value
    })
    return ok(result)
  } catch (error) {
    if (error instanceof AttemptRollback) return err(error.failure)
    throw error
  }
}

async function findReceipt<
  QueryResult extends PgQueryResultHKT,
  Schema extends Record<string, unknown>,
>(
  tx: DrizzleMutationTransaction<QueryResult, Schema>,
  actorScope: string,
  mutationId: string
): Promise<StoredReceipt | undefined> {
  const [recorded] = await tx
    .select({
      protocol: headcanonMutationReceipts.protocol,
      canonicalInvocation: headcanonMutationReceipts.canonicalInvocation,
      canonicalFingerprint: headcanonMutationReceipts.canonicalFingerprint,
      terminalOutcome: headcanonMutationReceipts.terminalOutcome,
    })
    .from(headcanonMutationReceipts)
    .where(
      and(
        eq(headcanonMutationReceipts.actorScope, actorScope),
        eq(headcanonMutationReceipts.mutationId, mutationId)
      )
    )
    .for("update")
  return recorded
}

/**
 * Reads the database clock in whole epoch milliseconds. `clock_timestamp()`
 * is the time of this statement; `now()` would be the transaction start,
 * before the advisory-lock wait.
 */
async function readDatabaseClockMs<
  QueryResult extends PgQueryResultHKT,
  Schema extends Record<string, unknown>,
>(tx: DrizzleMutationTransaction<QueryResult, Schema>): Promise<number> {
  const [clock] = await tx
    .select({
      nowMs:
        sql<number>`(extract(epoch from date_trunc('milliseconds', clock_timestamp())) * 1000)::float8`.mapWith(
          Number
        ),
    })
    .from(sql`(select 1) as headcanon_clock`)
  if (!clock) throw new Error("The database returned no clock reading")

  return clock.nowMs
}

async function insertReceipt<
  QueryResult extends PgQueryResultHKT,
  Schema extends Record<string, unknown>,
>(
  tx: DrizzleMutationTransaction<QueryResult, Schema>,
  actorScope: string,
  mutationId: string,
  admittedAtMs: number,
  receipt: StoredReceipt
): Promise<void> {
  await tx.insert(headcanonMutationReceipts).values({
    ...receipt,
    actorScope,
    mutationId,
    createdAt: new Date(admittedAtMs),
  })
}

/**
 * Deletes up to `limit` receipts recorded more than `retentionMs` before the
 * database clock, oldest first, skipping rows another transaction has locked.
 * Internal: `deleteExpiredReceipts` calls it on the database; tests call it
 * inside a held transaction.
 * @returns The number of receipts deleted.
 */
export async function deleteReceiptsOlderThan<
  QueryResult extends PgQueryResultHKT,
  Schema extends Record<string, unknown>,
>(
  executor: PgDatabase<QueryResult, Schema>,
  retentionMs: number,
  limit: number
): Promise<number> {
  const receipts = headcanonMutationReceipts
  const expired = executor
    .select({
      actorScope: receipts.actorScope,
      mutationId: receipts.mutationId,
    })
    .from(receipts)
    .where(
      lt(
        receipts.createdAt,
        sql`date_trunc('milliseconds', now()) - ${retentionMs}::float8 * interval '1 millisecond'`
      )
    )
    .orderBy(asc(receipts.createdAt))
    .limit(limit)
    .for("update", { skipLocked: true })

  const deleted = await executor
    .delete(receipts)
    .where(sql`(${receipts.actorScope}, ${receipts.mutationId}) in ${expired}`)
    .returning({ mutationId: receipts.mutationId })

  return deleted.length
}

/**
 * Creates the Postgres mutation authority for a Drizzle database. It
 * requires an interactive transaction client.
 *
 * Receipts, replay, the delivery window, and contention reruns work as
 * `createNextMutationAction` describes. A transaction-scoped advisory lock
 * on the actor scope and mutation ID serializes executions of one mutation.
 * The delivery window uses the database clock, read after the receipt
 * lookup, and each receipt's `created_at` is that reading.
 * PostgreSQL serialization failure, deadlock, and lock-not-available errors,
 * and errors that `isContentionError` marks, count as contention. A refused or
 * denied command's writes roll back and its outcome is recorded. Any other
 * error from a command or the database propagates from `execute` with no
 * receipt.
 *
 * Every attempt runs at READ COMMITTED, whatever the database default. Guard
 * writes with compare-and-set and call `throwMutationContention()` from
 * `headcanon/server` when the guard fails. The adapter does not decide actor
 * identity, authorization, or domain rules.
 *
 * @param options The database, actor scope, retry policy, and delivery window.
 * @returns A mutation authority whose `preflight` executor is `options.db`, with receipt cleanup.
 * @throws Error when `maxAttempts`, `maxDeliveryAgeMs`, or `clockSkewToleranceMs` is invalid.
 */
export function createDrizzleMutationAuthority<
  QueryResult extends PgQueryResultHKT,
  Schema extends Record<string, unknown>,
  Actor,
  Refusal,
>(
  options: DrizzleMutationAuthorityOptions<QueryResult, Schema, Actor>
): DrizzleMutationAuthority<QueryResult, Schema, Actor, Refusal> {
  const deliveryAge = deliveryAgePolicy(options)
  const retry = contentionRetry({
    maxAttempts: options.maxAttempts,
    isStoreContention: (error) =>
      isPostgresContention(error) ||
      options.isContentionError?.(error) === true,
  })

  return {
    preflight: options.db,
    scope: options.scope,
    execute(request, run) {
      const actorScope = options.scope(request.actor)
      const key = receiptKey(actorScope, request.mutationId)

      return retry(request.mutationId, () =>
        options.db.transaction(
          async (tx) => {
            // Serialize executions of one receipt key before its receipt is read.
            await tx.execute(
              sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`
            )

            const recorded = await findReceipt(
              tx,
              actorScope,
              request.mutationId
            )
            if (recorded) return replayReceipt(recorded, request)

            // Read after the lookup completes, so a receipt that cleanup
            // deleted meanwhile is judged at a time no earlier than the delete.
            const admittedAtMs = await readDatabaseClockMs(tx)
            const admitted = checkDeliveryAge(
              deliveryAge,
              request,
              admittedAtMs
            )
            if (!admitted.ok) return admitted

            const stamp = createStampAccumulator()
            const attempted = await runAttemptInSavepoint(tx, run, stamp)
            const { stored, terminal } = prepareTerminalOutcome(
              attempted,
              stamp,
              request
            )
            await insertReceipt(
              tx,
              actorScope,
              request.mutationId,
              admittedAtMs,
              storedReceipt(request, stored)
            )

            return ok(terminal)
          },
          // A stricter level takes the snapshot at the lock statement, before
          // the lock is granted, so a duplicate that waited could miss its
          // twin's receipt and run the command again.
          { isolationLevel: "read committed" }
        )
      )
    },
    async deleteExpiredReceipts(cleanup = {}) {
      const retentionMs = receiptRetentionMs(
        deliveryAge,
        cleanup.marginMs ?? DEFAULT_RECEIPT_CLEANUP_MARGIN_MS
      )
      const limit = cleanup.limit ?? DEFAULT_RECEIPT_CLEANUP_LIMIT
      if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new Error("limit must be a positive safe integer")
      }

      return deleteReceiptsOlderThan(options.db, retentionMs, limit)
    },
  }
}
