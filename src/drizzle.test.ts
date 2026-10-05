import { readFileSync } from "node:fs"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import { and, asc, eq, sql } from "drizzle-orm"
import {
  drizzle,
  type NodePgDatabase,
  type NodePgQueryResultHKT,
} from "drizzle-orm/node-postgres"
import { integer, pgTable, text, type PgDatabase } from "drizzle-orm/pg-core"
import { Pool } from "pg"
import { err, ok } from "serializable-result"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { executePreparedMutation, prepareMutationRequest } from "./authority"
import {
  createDrizzleMutationAuthority,
  type DrizzleMutationTransaction,
} from "./drizzle"
import { defineMutation, defineProtocol } from "./protocol"
import { headcanonMutationReceipts } from "./receipt-table"
import {
  MUTATION_AUTHORITY_CONTRACT_AXES,
  MUTATION_AUTHORITY_CONTRACT_INITIAL_STATE,
  verifyMutationAuthorityContract,
  type MutationAuthorityContractAxis,
  type MutationAuthorityContractHarness,
  type MutationAuthorityContractRefusal,
  type MutationAuthorityContractState,
} from "./testing/contracts"

const databaseUrl =
  process.env.HEADCANON_TEST_DATABASE_URL ?? process.env.DATABASE_URL
const receiptMigration = readFileSync(
  new URL("../drizzle/0000_headcanon_mutation_receipts.sql", import.meta.url),
  "utf8"
)

const contractAxes = pgTable("headcanon_contract_axes", {
  axis: text("axis").primaryKey(),
  value: integer("value").notNull(),
  revision: integer("revision").notNull(),
})

const contractEffects = pgTable("headcanon_contract_effects", {
  sequence: integer("sequence").generatedAlwaysAsIdentity().primaryKey(),
  effect: text("effect").notNull(),
})

const schema = {
  contractAxes,
  contractEffects,
  headcanonMutationReceipts,
}

type ContractDatabase = NodePgDatabase<typeof schema>
type ContractTransaction = DrizzleMutationTransaction<
  NodePgQueryResultHKT,
  typeof schema
>
type ContractExecutor = PgDatabase<NodePgQueryResultHKT, typeof schema>

const CONTRACT_AXES = Object.keys(
  MUTATION_AUTHORITY_CONTRACT_AXES
) as readonly MutationAuthorityContractAxis[]

/**
 * Database defaults the adapter must tolerate. It pins its own attempts to
 * READ COMMITTED; under the other two, a lock-before-snapshot mistake lets a
 * waiting duplicate rerun the command.
 */
const DATABASE_ISOLATION_LEVELS = [
  "read committed",
  "repeatable read",
  "serializable",
] as const
type IsolationLevel = (typeof DATABASE_ISOLATION_LEVELS)[number]

function connectionUrl(
  url: string,
  schemaName: string,
  isolation: IsolationLevel
): string {
  const parsed = new URL(url)
  const existing = parsed.searchParams.get("options")
  parsed.searchParams.set(
    "options",
    [
      existing,
      `-c search_path=${schemaName}`,
      `-c default_transaction_isolation=${isolation.replace(" ", "\\ ")}`,
    ]
      .filter(Boolean)
      .join(" ")
  )
  return parsed.toString()
}

async function loadState(
  executor: ContractExecutor
): Promise<MutationAuthorityContractState> {
  const rows = await executor.select().from(contractAxes)
  const effects = await executor
    .select({ effect: contractEffects.effect })
    .from(contractEffects)
    .orderBy(asc(contractEffects.sequence))
  const byName = new Map(rows.map((row) => [row.axis, row]))
  const axes = Object.fromEntries(
    CONTRACT_AXES.map((axis) => {
      const row = byName.get(axis)
      if (!row) throw new Error(`Missing contract axis: ${axis}`)
      return [axis, { value: row.value, revision: row.revision }]
    })
  ) as MutationAuthorityContractState["axes"]

  return { axes, effects: effects.map(({ effect }) => effect) }
}

async function replaceState(
  db: ContractDatabase,
  next: MutationAuthorityContractState
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(contractEffects)
    if (next.effects.length > 0) {
      await tx
        .insert(contractEffects)
        .values(next.effects.map((effect) => ({ effect })))
    }
    await tx.delete(contractAxes)
    await tx.insert(contractAxes).values(
      CONTRACT_AXES.map((axis) => ({
        axis,
        value: next.axes[axis].value,
        revision: next.axes[axis].revision,
      }))
    )
  })
}

function contractHarness(
  db: () => ContractDatabase,
  isolation: IsolationLevel
): MutationAuthorityContractHarness<ContractTransaction, ContractDatabase> {
  return {
    name: `drizzle/Postgres (database default ${isolation})`,
    async create() {
      const database = db()
      await database.delete(headcanonMutationReceipts)
      await replaceState(database, MUTATION_AUTHORITY_CONTRACT_INITIAL_STATE)

      return {
        authority: createDrizzleMutationAuthority<
          NodePgQueryResultHKT,
          typeof schema,
          string,
          MutationAuthorityContractRefusal
        >({ db: database, scope: (actor) => actor }),
        load: loadState,
        async writeAxis(tx, axis, expectedRevision, next) {
          const written = await tx
            .update(contractAxes)
            .set(next)
            .where(
              and(
                eq(contractAxes.axis, axis),
                eq(contractAxes.revision, expectedRevision)
              )
            )
            .returning({ axis: contractAxes.axis })
          return written.length === 1
        },
        async appendEffect(tx, effect) {
          await tx.insert(contractEffects).values({ effect })
        },
        replace: (next) => replaceState(database, next),
        receiptCount: () => database.$count(headcanonMutationReceipts),
        hasReceipt: async (mutationId) =>
          (await database.$count(
            headcanonMutationReceipts,
            eq(headcanonMutationReceipts.mutationId, mutationId)
          )) === 1,
      }
    },
  }
}

const touchArgs: StandardSchemaV1<unknown, { readonly effect: string }> = {
  "~standard": {
    version: 1,
    vendor: "headcanon-drizzle-test",
    validate(value) {
      return { value: value as { readonly effect: string } }
    },
  },
}
const touch = defineMutation({
  name: "drizzle.touch",
  args: touchArgs,
  predict(state: null) {
    return ok(state)
  },
})
const touchProtocol = defineProtocol({
  id: "test.drizzle.v1",
  mutations: [touch],
})

describe.skipIf(!databaseUrl)("Drizzle/Postgres mutation authority", () => {
  const schemaName = `headcanon_${process.pid}_${Date.now()}`
  let adminPool: Pool | undefined
  const pools = new Map<IsolationLevel, Pool>()
  const databases = new Map<IsolationLevel, ContractDatabase>()
  let schemaCreated = false

  const database = (isolation: IsolationLevel) => {
    const db = databases.get(isolation)
    if (!db) throw new Error(`No database for ${isolation}`)
    return db
  }

  beforeAll(async () => {
    if (!databaseUrl) return
    adminPool = new Pool({ connectionString: databaseUrl })
    const admin = drizzle(adminPool)
    await admin.execute(sql.raw(`create schema "${schemaName}"`))
    schemaCreated = true

    for (const isolation of DATABASE_ISOLATION_LEVELS) {
      const pool = new Pool({
        connectionString: connectionUrl(databaseUrl, schemaName, isolation),
      })
      pools.set(isolation, pool)
      databases.set(isolation, drizzle(pool, { schema }))
    }

    const db = database("read committed")
    for (const statement of receiptMigration.split(
      "--> statement-breakpoint"
    )) {
      if (statement.trim().length > 0) await db.execute(sql.raw(statement))
    }
    await db.execute(sql`
      create table ${contractAxes} (
        axis text primary key,
        value integer not null,
        revision integer not null
      )
    `)
    await db.execute(sql`
      create table ${contractEffects} (
        sequence integer generated always as identity primary key,
        effect text not null
      )
    `)
  })

  afterAll(async () => {
    if (!databaseUrl) return
    await Promise.all([...pools.values()].map((pool) => pool.end()))
    if (adminPool && schemaCreated) {
      const admin = drizzle(adminPool)
      await admin.execute(sql.raw(`drop schema "${schemaName}" cascade`))
    }
    await adminPool?.end()
  })

  it("connects each harness with its database default isolation", async () => {
    for (const isolation of DATABASE_ISOLATION_LEVELS) {
      const result = await database(isolation).execute<{
        default_transaction_isolation: string
      }>(sql`show default_transaction_isolation`)
      expect(result.rows[0]?.default_transaction_isolation).toBe(isolation)
    }
  })

  for (const isolation of DATABASE_ISOLATION_LEVELS) {
    verifyMutationAuthorityContract(
      contractHarness(() => database(isolation), isolation)
    )
  }

  it("rolls back real Postgres serialization failures without a receipt", async () => {
    const db = database("read committed")
    await db.delete(headcanonMutationReceipts)
    await db.delete(contractEffects)
    const authority = createDrizzleMutationAuthority({
      db,
      scope: (actor: string) => actor,
    })
    let serializationFailures = 2
    const execute = async () => {
      const prepared = await prepareMutationRequest(touchProtocol, {
        protocol: touchProtocol.id,
        mutationId: "10000000-0000-4000-8000-000000000100",
        invocation: touch({ effect: "serialization" }),
      })
      if (!prepared.ok) throw new Error("Invalid serialization envelope")
      return executePreparedMutation({
        prepared: prepared.value,
        actor: "serialization-actor",
        authority,
        async run(tx) {
          if (serializationFailures > 0) {
            serializationFailures -= 1
            await tx.execute(
              sql.raw(
                "do $$ begin raise exception 'fixture serialization failure' using errcode = '40001'; end $$"
              )
            )
          }
          await tx.insert(contractEffects).values({ effect: "serialization" })
          return ok(undefined)
        },
      })
    }

    await expect(execute()).resolves.toEqual(
      err({
        code: "contention",
        mutationId: "10000000-0000-4000-8000-000000000100",
      })
    )
    expect(await db.$count(headcanonMutationReceipts)).toBe(0)
    expect(await db.$count(contractEffects)).toBe(0)

    await expect(execute()).resolves.toMatchObject({ ok: true })
    expect(await db.$count(headcanonMutationReceipts)).toBe(1)
    expect(await db.$count(contractEffects)).toBe(1)
  })
})
