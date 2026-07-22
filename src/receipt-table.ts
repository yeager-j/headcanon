import {
  char,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core"

/**
 * The mutation-receipt table definition, isolated from the authority adapter so
 * that adopters can include it in their Drizzle schema and migrations without
 * pulling the executor graph (and its `canonicalize` dependency) into
 * schema-only tooling such as `drizzle-kit`. The adapter imports the table for
 * its queries without re-exporting it; schema consumers use the dedicated
 * `@workspace/headcanon/drizzle-schema` entry.
 */

/** The durable terminal outcome stored per mutation, as serialized JSON. */
export type StoredMutationTerminalOutcome =
  | {
      readonly kind: "accepted"
      readonly stamp: { readonly revisions: unknown }
    }
  | { readonly kind: "rejected"; readonly error: unknown }
  | { readonly kind: "denied" }

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
