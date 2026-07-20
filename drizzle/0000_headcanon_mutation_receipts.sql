CREATE TABLE "headcanon_mutation_receipts" (
	"actor_scope" text NOT NULL,
	"mutation_id" uuid NOT NULL,
	"protocol" text NOT NULL,
	"canonical_invocation" text NOT NULL,
	"canonical_fingerprint" char(64) NOT NULL,
	"terminal_outcome" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "headcanon_mutation_receipts_actor_scope_mutation_id_pk" PRIMARY KEY("actor_scope", "mutation_id")
);
--> statement-breakpoint
CREATE INDEX "headcanon_mutation_receipts_fingerprint_idx" ON "headcanon_mutation_receipts" USING btree ("canonical_fingerprint");
--> statement-breakpoint
CREATE INDEX "headcanon_mutation_receipts_created_at_idx" ON "headcanon_mutation_receipts" USING btree ("created_at");
