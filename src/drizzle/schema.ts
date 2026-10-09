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

import type { StoredTerminalOutcome } from "../core/authority"

// Schema tooling such as drizzle-kit loads this entry, so at runtime it imports
// only drizzle-orm: import anything else as a type.

/**
 * The durable terminal outcome stored per mutation or operation, as
 * serialized JSON. An operation's accepted outcome also holds its result.
 */
export type StoredMutationTerminalOutcome = StoredTerminalOutcome

/**
 * Durable authority outcomes keyed by trusted actor scope and mutation UUID.
 * Mutations and operations share it: `protocol` holds an operation's
 * reserved ID, `headcanon:operation`.
 * The adapter writes each receipt once and never updates it. `created_at` is
 * the database clock reading that admitted the mutation; it is indexed for
 * `deleteExpiredReceipts` on the Drizzle authority.
 */
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
  },
  (receipt) => [
    primaryKey({ columns: [receipt.actorScope, receipt.mutationId] }),
    index("headcanon_mutation_receipts_created_at_idx").on(receipt.createdAt),
  ]
)
