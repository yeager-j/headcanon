import { and, eq, sql } from "drizzle-orm"
import {
  type PgDatabase,
  type PgQueryResultHKT,
  type PgTransaction,
} from "drizzle-orm/pg-core"
import type { ExtractTablesWithRelations } from "drizzle-orm/relations"
import { ok, type Result } from "serializable-result"

import {
  contentionRetry,
  createStampAccumulator,
  mutationReceipt,
  receiptKey,
  recordTerminalOutcome,
  replayReceipt,
  type MutationAttemptFailure,
  type MutationAuthorityAdapter,
} from "./authority"
import {
  headcanonMutationReceipts,
  type StoredMutationTerminalOutcome,
} from "./receipt-table"

// The receipt table is defined in `./receipt-table` (drizzle-orm only, so schema
// tooling never loads the authority graph) and published from the dedicated
// `./drizzle-schema` entry. This adapter imports it for its own queries; it does
// not re-export it, so the table has exactly one public home (UNN-673).

/** Transaction-capable Drizzle client shape accepted by the authority adapter. */
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

/** Application policy and database hooks used by the Drizzle authority adapter. */
export interface DrizzleMutationAuthorityOptions<
  QueryResult extends PgQueryResultHKT,
  Schema extends Record<string, unknown>,
  Actor,
> {
  readonly db: PgDatabase<QueryResult, Schema>
  readonly scope: (actor: Actor) => string
  readonly maxAttempts?: number
  readonly isContentionError?: (error: unknown) => boolean
}

/** Rolls back the attempt savepoint of a refused or denied command. */
class RollBackAttempt extends Error {
  constructor() {
    super("Roll back the refused mutation attempt")
    this.name = "RollBackAttempt"
  }
}

/** SQLSTATE and optional constraint pattern used to classify contention errors. */
export interface PostgresErrorMatch {
  readonly code: string
  readonly constraint?: string
}

/**
 * Matches a PostgreSQL error anywhere in a cycle-safe causal chain.
 * @param error Unknown thrown value or causal chain root.
 * @param expected SQLSTATE and optional constraint to match.
 * @returns Whether the chain contains the expected PostgreSQL error.
 */
export function matchesPostgresError(
  error: unknown,
  expected: PostgresErrorMatch
): boolean {
  let current = error
  const visited = new Set<object>()

  while (
    current !== null &&
    typeof current === "object" &&
    !visited.has(current)
  ) {
    visited.add(current)
    const errorLike = current as {
      readonly code?: unknown
      readonly constraint?: unknown
      readonly cause?: unknown
    }
    if (
      errorLike.code === expected.code &&
      (expected.constraint === undefined ||
        errorLike.constraint === expected.constraint)
    ) {
      return true
    }
    current = errorLike.cause
  }

  return false
}

function isPostgresContention(error: unknown): boolean {
  return ["40001", "40P01", "55P03"].some((code) =>
    matchesPostgresError(error, { code })
  )
}

/**
 * Creates the Postgres authority adapter around an interactive Drizzle client.
 *
 * Each execution derives a trusted actor scope, acquires a transaction-scoped
 * advisory lock before receipt or application-row access, and runs the command
 * callback inside a transaction attempt. Duplicate mutation IDs return the
 * stored terminal outcome when canonical bytes match; a reused ID with
 * different bytes returns `mutation-id-reused`. PostgreSQL serialization,
 * deadlock, lock-timeout, and application-classified contention roll back the
 * attempt and retry from fresh state up to `maxAttempts`. The adapter requires
 * an interactive transaction client and does not decide actor identity,
 * authorization, domain semantics, or projection ownership.
 *
 * Every attempt runs at READ COMMITTED, whatever the database default. Under
 * REPEATABLE READ or SERIALIZABLE the snapshot would be taken by the lock
 * statement itself, before the lock is granted, so a duplicate delivery that
 * waited on the lock could not see the receipt its twin had just committed
 * and would run the command again. Commands guard their own writes with
 * compare-and-set and `throwMutationContention()` from `headcanon` instead.
 *
 * @param options Interactive Drizzle client, trusted scope function, retry policy, and optional contention classification.
 * @returns A receipt-owning mutation authority with the database as preflight executor.
 * @throws Error when retry configuration is invalid or the database reports an unexpected failure.
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

      return retry(request.mutationId, () =>
        options.db.transaction(
          async (tx) => {
            await tx.execute(
              sql`select pg_advisory_xact_lock(hashtextextended(${receiptKey(actorScope, request.mutationId)}, 0))`
            )

            const [recorded] = await tx
              .select({
                protocol: headcanonMutationReceipts.protocol,
                canonicalInvocation:
                  headcanonMutationReceipts.canonicalInvocation,
                canonicalFingerprint:
                  headcanonMutationReceipts.canonicalFingerprint,
                terminalOutcome: headcanonMutationReceipts.terminalOutcome,
              })
              .from(headcanonMutationReceipts)
              .where(
                and(
                  eq(headcanonMutationReceipts.actorScope, actorScope),
                  eq(headcanonMutationReceipts.mutationId, request.mutationId)
                )
              )
              .for("update")
            if (recorded) return replayReceipt(recorded, request)

            const stamp = createStampAccumulator()
            let attempted: Result<void, MutationAttemptFailure<Refusal>> = ok(
              undefined
            )
            try {
              await tx.transaction(async (attemptTx) => {
                attempted = await run(attemptTx, stamp)
                if (!attempted.ok) throw new RollBackAttempt()
              })
            } catch (error) {
              if (!(error instanceof RollBackAttempt)) throw error
            }

            const { stored, terminal } = recordTerminalOutcome(
              attempted,
              stamp,
              request.parseRefusal
            )
            const receipt = mutationReceipt(request, stored)
            await tx.insert(headcanonMutationReceipts).values({
              ...receipt,
              actorScope,
              mutationId: request.mutationId,
              terminalOutcome:
                receipt.terminalOutcome as StoredMutationTerminalOutcome,
            })

            return ok(terminal)
          },
          { isolationLevel: "read committed" }
        )
      )
    },
  }
}
