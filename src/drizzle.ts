import { and, eq, sql } from "drizzle-orm"
import {
  type PgDatabase,
  type PgQueryResultHKT,
  type PgTransaction,
  type PgTransactionConfig,
} from "drizzle-orm/pg-core"
import type { ExtractTablesWithRelations } from "drizzle-orm/relations"

import { err, ok } from "@workspace/result"

import {
  createStampAccumulator,
  type MutationAuthorityAdapter,
  type MutationAuthorityRequest,
  type MutationTerminalOutcome,
} from "./authority"
import {
  headcanonMutationReceipts,
  type StoredMutationTerminalOutcome,
} from "./receipt-table"
import { acceptedStamp, revisionVector } from "./revisions"

// The receipt table is defined in `./receipt-table` (drizzle-orm only, so schema
// tooling never loads the authority graph) and published from the dedicated
// `./drizzle-schema` entry. This adapter imports it for its own queries; it does
// not re-export it, so the table has exactly one public home (UNN-673).

/** Transaction control flow for a guarded write that lost a race. */
export class MutationContentionError extends Error {
  constructor() {
    super("Mutation authority contention")
    this.name = "MutationContentionError"
  }
}

/**
 * Rolls the current attempt back so the authority can retry from current state.
 * @returns Never; throws transaction-control-flow contention.
 * @throws {@link MutationContentionError} to request an authority retry.
 */
export function throwMutationContention(): never {
  throw new MutationContentionError()
}

/** Transaction-capable Drizzle client shape accepted by the authority adapter. */
export type DrizzleMutationTransaction<
  QueryResult extends PgQueryResultHKT,
  Schema extends Record<string, unknown>,
> = PgTransaction<QueryResult, Schema, ExtractTablesWithRelations<Schema>>

/**
 * The transaction a mutation command runs inside, derived from the adopter's own
 * Drizzle database type. A command registered through `createNextMutationAction`
 * already infers this context; name it only when a command or Store needs an
 * explicit transaction type.
 */
export type DrizzleMutationTx<
  DB extends PgDatabase<PgQueryResultHKT, Record<string, unknown>>,
> = Parameters<Parameters<DB["transaction"]>[0]>[0]

/** Application policy and database hooks used by the Drizzle authority adapter. */
export interface DrizzleMutationAuthorityOptions<
  QueryResult extends PgQueryResultHKT,
  Schema extends Record<string, unknown>,
  Actor,
  Rejection,
> {
  readonly db: PgDatabase<QueryResult, Schema>
  readonly scope: (actor: Actor) => string
  readonly parseRejection?: (value: unknown) => Rejection
  readonly maxAttempts?: number
  readonly transaction?: PgTransactionConfig
  readonly isContentionError?: (error: unknown) => boolean
}

class TerminalDecision<Rejection> extends Error {
  constructor(
    readonly decision:
      | { readonly kind: "refused"; readonly error: Rejection }
      | { readonly kind: "denied" }
  ) {
    super("Terminal mutation decision")
    this.name = "TerminalDecision"
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactly(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  )
}

function parseStoredOutcome<Rejection>(
  value: unknown,
  parseRejection?: (value: unknown) => Rejection
): MutationTerminalOutcome<Rejection> {
  if (!isPlainRecord(value) || typeof value.kind !== "string") {
    throw new Error("Invalid mutation receipt outcome")
  }

  if (value.kind === "accepted") {
    if (
      !hasExactly(value, ["kind", "stamp"]) ||
      !isPlainRecord(value.stamp) ||
      !hasExactly(value.stamp, ["revisions"])
    ) {
      throw new Error("Invalid accepted mutation receipt")
    }
    const revisions = revisionVector(value.stamp.revisions)
    if (!revisions.ok) {
      throw new Error("Invalid accepted mutation receipt revisions")
    }
    return Object.freeze({
      kind: "accepted",
      stamp: acceptedStamp(revisions.value),
    })
  }

  if (value.kind === "rejected" && hasExactly(value, ["kind", "error"])) {
    if (!parseRejection) {
      throw new Error("Missing mutation receipt refusal parser")
    }
    return Object.freeze({
      kind: "rejected",
      error: parseRejection(structuredClone(value.error)),
    })
  }

  if (value.kind === "denied" && hasExactly(value, ["kind"])) {
    return Object.freeze({ kind: "denied" })
  }

  throw new Error("Invalid terminal mutation receipt")
}

function serializeOutcome<Rejection>(
  outcome: MutationTerminalOutcome<Rejection>,
  parseRejection?: (value: unknown) => Rejection
): {
  readonly stored: StoredMutationTerminalOutcome
  readonly terminal: MutationTerminalOutcome<Rejection>
} {
  const json = JSON.stringify(outcome)
  if (json === undefined) {
    throw new Error("Mutation receipt outcome is not JSON serializable")
  }
  const stored: unknown = JSON.parse(json)
  const terminal = parseStoredOutcome(stored, parseRejection)
  return { stored: stored as StoredMutationTerminalOutcome, terminal }
}

function requestLockKey<Actor>(
  request: MutationAuthorityRequest<Actor>,
  actorScope: string
): string {
  return JSON.stringify([actorScope, request.mutationId])
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

function collision(mutationId: string) {
  return err({ code: "mutation-id-reused", mutationId } as const)
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
 * @param options Interactive Drizzle client, trusted scope function, retry policy, and optional contention/refusal hooks.
 * @returns A receipt-owning mutation authority with the database as preflight executor.
 * @throws Error when retry configuration is invalid or the database reports an unexpected failure.
 */
export function createDrizzleMutationAuthority<
  QueryResult extends PgQueryResultHKT,
  Schema extends Record<string, unknown>,
  Actor,
  Rejection,
>(
  options: DrizzleMutationAuthorityOptions<
    QueryResult,
    Schema,
    Actor,
    Rejection
  >
): MutationAuthorityAdapter<
  DrizzleMutationTransaction<QueryResult, Schema>,
  Actor,
  Rejection,
  PgDatabase<QueryResult, Schema>
> & { readonly preflight: PgDatabase<QueryResult, Schema> } {
  const maxAttempts = options.maxAttempts ?? 2
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("maxAttempts must be a positive integer")
  }

  const retryable = (error: unknown) =>
    error instanceof MutationContentionError ||
    isPostgresContention(error) ||
    options.isContentionError?.(error) === true

  return {
    preflight: options.db,
    async execute(request, run) {
      const actorScope = options.scope(request.actor)
      const parseRejection = request.parseRejection ?? options.parseRejection

      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
          return await options.db.transaction(async (tx) => {
            await tx.execute(
              sql`select pg_advisory_xact_lock(hashtextextended(${requestLockKey(request, actorScope)}, 0))`
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

            if (recorded) {
              if (
                recorded.protocol !== request.protocol ||
                recorded.canonicalInvocation !== request.canonical.json ||
                recorded.canonicalFingerprint !== request.canonical.sha256
              ) {
                return collision(request.mutationId)
              }
              return ok(
                parseStoredOutcome(recorded.terminalOutcome, parseRejection)
              )
            }

            const stamp = createStampAccumulator()
            let terminal: MutationTerminalOutcome<Rejection>

            try {
              await tx.transaction(async (attemptTx) => {
                const attempted = await run(attemptTx, stamp)
                if (!attempted.ok) throw new TerminalDecision(attempted.error)
              })
              terminal = { kind: "accepted", stamp: stamp.accepted() }
            } catch (error) {
              if (!(error instanceof TerminalDecision)) throw error
              terminal =
                error.decision.kind === "denied"
                  ? { kind: "denied" }
                  : { kind: "rejected", error: error.decision.error }
            }

            const serialized = serializeOutcome(terminal, parseRejection)
            await tx.insert(headcanonMutationReceipts).values({
              actorScope,
              mutationId: request.mutationId,
              protocol: request.protocol,
              canonicalInvocation: request.canonical.json,
              canonicalFingerprint: request.canonical.sha256,
              terminalOutcome: serialized.stored,
            })

            return ok(serialized.terminal)
          }, options.transaction)
        } catch (error) {
          if (!retryable(error)) throw error
          if (attempt === maxAttempts - 1) {
            return err({
              code: "contention",
              mutationId: request.mutationId,
            } as const)
          }
        }
      }

      throw new Error("Mutation authority attempt loop did not terminate")
    },
  }
}
