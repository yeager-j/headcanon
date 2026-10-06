import { and, eq, sql } from "drizzle-orm"
import {
  type PgDatabase,
  type PgQueryResultHKT,
  type PgTransaction,
} from "drizzle-orm/pg-core"
import type { ExtractTablesWithRelations } from "drizzle-orm/relations"
import { err, ok, type Result } from "serializable-result"

import {
  contentionRetry,
  createStampAccumulator,
  prepareTerminalOutcome,
  receiptKey,
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
   * ID, so it must be stable for one actor.
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
}

/** Thrown inside the attempt savepoint so Drizzle rolls back a refused or denied command's writes. */
class AttemptRollback<Refusal> extends Error {
  readonly failure: MutationAttemptFailure<Refusal>

  constructor(failure: MutationAttemptFailure<Refusal>) {
    super("Roll back the refused or denied mutation attempt")
    this.name = "AttemptRollback"
    this.failure = failure
  }
}

/** Runs one command attempt in a savepoint whose writes roll back when the command is refused or denied. */
async function runAttemptInSavepoint<
  QueryResult extends PgQueryResultHKT,
  Schema extends Record<string, unknown>,
  Refusal,
>(
  tx: DrizzleMutationTransaction<QueryResult, Schema>,
  run: (
    tx: DrizzleMutationTransaction<QueryResult, Schema>,
    stamp: StampAccumulator
  ) => Promise<Result<void, MutationAttemptFailure<Refusal>>>,
  stamp: StampAccumulator
): Promise<Result<void, MutationAttemptFailure<Refusal>>> {
  try {
    await tx.transaction(async (attemptTx) => {
      const attempted = await run(attemptTx, stamp)
      if (!attempted.ok) throw new AttemptRollback(attempted.error)
    })
  } catch (error) {
    if (error instanceof AttemptRollback) return err(error.failure)
    throw error
  }
  return ok(undefined)
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

async function insertReceipt<
  QueryResult extends PgQueryResultHKT,
  Schema extends Record<string, unknown>,
>(
  tx: DrizzleMutationTransaction<QueryResult, Schema>,
  actorScope: string,
  mutationId: string,
  receipt: StoredReceipt
): Promise<void> {
  await tx.insert(headcanonMutationReceipts).values({
    ...receipt,
    actorScope,
    mutationId,
  })
}

/**
 * Creates the Postgres {@link MutationAuthorityAdapter} for a Drizzle
 * database. It requires an interactive transaction client.
 *
 * Receipts, replay, and contention reruns follow the
 * {@link MutationAuthorityAdapter} rules. A transaction-scoped advisory lock
 * on the actor scope and mutation ID serializes executions of one mutation.
 * PostgreSQL serialization failure, deadlock, and lock-not-available errors,
 * and errors that `isContentionError` marks, count as contention. A refused or
 * denied command's writes roll back and its outcome is recorded. Any other
 * error from a command or the database propagates from `execute` with no
 * receipt.
 *
 * Every attempt runs at READ COMMITTED, whatever the database default. Guard
 * writes with compare-and-set and call `throwMutationContention()` from
 * `headcanon` when the guard fails. The adapter does not decide actor
 * identity, authorization, or domain rules.
 *
 * @param options The database, actor scope, and retry policy.
 * @returns A mutation authority whose `preflight` executor is `options.db`.
 * @throws Error when `maxAttempts` is not a positive integer.
 */
export function createDrizzleMutationAuthority<
  QueryResult extends PgQueryResultHKT,
  Schema extends Record<string, unknown>,
  Actor,
  Refusal,
>(
  options: DrizzleMutationAuthorityOptions<QueryResult, Schema, Actor>
): MutationAuthorityAdapter<
  DrizzleMutationTransaction<QueryResult, Schema>,
  Actor,
  Refusal,
  PgDatabase<QueryResult, Schema>
> {
  const retry = contentionRetry({
    maxAttempts: options.maxAttempts,
    isStoreContention: (error) =>
      isPostgresContention(error) ||
      options.isContentionError?.(error) === true,
  })

  return {
    preflight: options.db,
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

            const stamp = createStampAccumulator()
            const attempted = await runAttemptInSavepoint(tx, run, stamp)
            const { stored, terminal } = prepareTerminalOutcome(
              attempted,
              stamp,
              request.parseRefusal
            )
            await insertReceipt(
              tx,
              actorScope,
              request.mutationId,
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
  }
}
