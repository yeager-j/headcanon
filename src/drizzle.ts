import { and, eq, sql } from "drizzle-orm"
import {
  char,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
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
import { acceptedStamp, revisionVector } from "./revisions"

type StoredMutationTerminalOutcome =
  | {
      readonly kind: "accepted"
      readonly stamp: { readonly revisions: unknown }
    }
  | { readonly kind: "rejected"; readonly error: unknown }

/** Durable authority outcomes keyed by trusted actor scope and mutation UUID. */
export const headcanonMutationReceipts = pgTable(
  "headcanon_mutation_receipts",
  {
    actorScope: text("actor_scope").notNull(),
    mutationId: uuid("mutation_id").notNull(),
    protocol: text("protocol").notNull(),
    canonicalInvocation: text("canonical_invocation").notNull(),
    canonicalFingerprint: char("canonical_fingerprint", {
      length: 64,
    }).notNull(),
    terminalOutcome: jsonb("terminal_outcome")
      .$type<StoredMutationTerminalOutcome>()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (receipt) => [
    primaryKey({ columns: [receipt.actorScope, receipt.mutationId] }),
    index("headcanon_mutation_receipts_fingerprint_idx").on(
      receipt.canonicalFingerprint
    ),
    index("headcanon_mutation_receipts_created_at_idx").on(receipt.createdAt),
  ]
)

/** Transaction control flow for a guarded write that lost a race. */
export class MutationContentionError extends Error {
  constructor() {
    super("Mutation authority contention")
    this.name = "MutationContentionError"
  }
}

/** Rolls the current attempt back so the authority can retry from current state. */
export function throwMutationContention(): never {
  throw new MutationContentionError()
}

export type DrizzleMutationTransaction<
  QueryResult extends PgQueryResultHKT,
  Schema extends Record<string, unknown>,
> = PgTransaction<QueryResult, Schema, ExtractTablesWithRelations<Schema>>

export interface DrizzleMutationAuthorityOptions<
  QueryResult extends PgQueryResultHKT,
  Schema extends Record<string, unknown>,
  Actor,
  Rejection,
> {
  readonly db: PgDatabase<QueryResult, Schema>
  readonly scope: (actor: Actor) => string
  readonly parseRejection: (value: unknown) => Rejection
  readonly maxAttempts?: number
  readonly transaction?: PgTransactionConfig
  readonly isContentionError?: (error: unknown) => boolean
}

class TerminalRejection<Rejection> extends Error {
  constructor(readonly rejection: Rejection) {
    super("Terminal mutation rejection")
    this.name = "TerminalRejection"
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
  parseRejection: (value: unknown) => Rejection
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
    return Object.freeze({
      kind: "rejected",
      error: parseRejection(structuredClone(value.error)),
    })
  }

  throw new Error("Invalid rejected mutation receipt")
}

function serializeOutcome<Rejection>(
  outcome: MutationTerminalOutcome<Rejection>,
  parseRejection: (value: unknown) => Rejection
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

function errorCode(error: unknown): string | undefined {
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
      readonly cause?: unknown
    }
    if (typeof errorLike.code === "string") return errorLike.code
    current = errorLike.cause
  }

  return undefined
}

function isPostgresContention(error: unknown): boolean {
  const code = errorCode(error)
  return code === "40001" || code === "40P01" || code === "55P03"
}

function collision(mutationId: string) {
  return err({ code: "mutation-id-reused", mutationId } as const)
}

/**
 * Creates the Postgres authority adapter around an interactive Drizzle client.
 *
 * The transaction-scoped advisory lock is acquired before any receipt or
 * application row access. Hash collisions can only serialize unrelated
 * mutations; exact receipt identity and equality still use the primary key and
 * canonical invocation text.
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
  Rejection
> {
  const maxAttempts = options.maxAttempts ?? 2
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("maxAttempts must be a positive integer")
  }

  const retryable = (error: unknown) =>
    error instanceof MutationContentionError ||
    isPostgresContention(error) ||
    options.isContentionError?.(error) === true

  return {
    async execute(request, run) {
      const actorScope = options.scope(request.actor)

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
                parseStoredOutcome(
                  recorded.terminalOutcome,
                  options.parseRejection
                )
              )
            }

            const stamp = createStampAccumulator()
            let terminal: MutationTerminalOutcome<Rejection>

            try {
              await tx.transaction(async (handlerTx) => {
                const handled = await run(handlerTx, stamp)
                if (!handled.ok) throw new TerminalRejection(handled.error)
              })
              terminal = { kind: "accepted", stamp: stamp.accepted() }
            } catch (error) {
              if (!(error instanceof TerminalRejection)) throw error
              terminal = { kind: "rejected", error: error.rejection }
            }

            const serialized = serializeOutcome(
              terminal,
              options.parseRejection
            )
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
