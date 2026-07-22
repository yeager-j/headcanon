import { readFileSync } from "node:fs"
import { and, asc, eq, sql } from "drizzle-orm"
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"
import { integer, pgTable, text } from "drizzle-orm/pg-core"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { err, ok } from "@workspace/result"

import { executePreparedMutation, prepareMutationRequest } from "./authority"
import {
  createDrizzleMutationAuthority,
  throwMutationContention,
} from "./drizzle"
import { headcanonMutationReceipts } from "./receipt-table"
import { revision } from "./revisions"
import {
  MUTATION_AUTHORITY_CONTRACT_ACTOR,
  MUTATION_AUTHORITY_CONTRACT_AXES,
  MUTATION_AUTHORITY_CONTRACT_INITIAL_STATE,
  MUTATION_AUTHORITY_CONTRACT_MUTATION,
  MUTATION_AUTHORITY_CONTRACT_PROTOCOL,
  mutationAuthorityContractProtocol,
  verifyMutationAuthorityContract,
  type MutationAuthorityContractArgs,
  type MutationAuthorityContractDriver,
  type MutationAuthorityContractRejection,
  type MutationAuthorityContractState,
} from "./testing"

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

const PRIMARY = "primary"
const SECONDARY = "secondary"
const ROLLBACK = "rollback"

function schemaUrl(url: string, schemaName: string): string {
  const parsed = new URL(url)
  const existing = parsed.searchParams.get("options")
  parsed.searchParams.set(
    "options",
    [existing, `-c search_path=${schemaName}`].filter(Boolean).join(" ")
  )
  return parsed.toString()
}

function contractEnvelope(
  sequence: number,
  args: MutationAuthorityContractArgs
) {
  return {
    protocol: MUTATION_AUTHORITY_CONTRACT_PROTOCOL,
    mutationId: `10000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`,
    invocation: { name: MUTATION_AUTHORITY_CONTRACT_MUTATION, args },
  }
}

function contractArgs(
  overrides: Partial<MutationAuthorityContractArgs> = {}
): MutationAuthorityContractArgs {
  return {
    amount: 1,
    axes: ["primary"],
    behavior: "accept",
    effect: "effect",
    maximumPrimary: null,
    ...overrides,
  }
}

function requireRevision(value: number) {
  const parsed = revision(value)
  if (!parsed.ok) throw new Error("Invalid contract fixture revision")
  return parsed.value
}

describe.skipIf(!databaseUrl)("Drizzle/Postgres mutation authority", () => {
  const schemaName = `headcanon_${process.pid}_${Date.now()}`
  let adminPool: Pool | undefined
  let pool: Pool | undefined
  let db: ContractDatabase
  let schemaCreated = false
  let serializationFailures = 0

  beforeAll(async () => {
    if (!databaseUrl) return
    adminPool = new Pool({ connectionString: databaseUrl })
    const admin = drizzle(adminPool)
    await admin.execute(sql.raw(`create schema "${schemaName}"`))
    schemaCreated = true

    pool = new Pool({ connectionString: schemaUrl(databaseUrl, schemaName) })
    db = drizzle(pool, { schema })
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
    await pool?.end()
    if (adminPool && schemaCreated) {
      const admin = drizzle(adminPool)
      await admin.execute(sql.raw(`drop schema "${schemaName}" cascade`))
    }
    await adminPool?.end()
  })

  async function reset() {
    serializationFailures = 0
    await db.transaction(async (tx) => {
      await tx.delete(headcanonMutationReceipts)
      await tx.delete(contractEffects)
      await tx.delete(contractAxes)
      await tx.insert(contractAxes).values([
        { axis: PRIMARY, value: 0, revision: 0 },
        { axis: SECONDARY, value: 0, revision: 0 },
        { axis: ROLLBACK, value: 0, revision: 0 },
      ])
    })
  }

  async function readState(): Promise<MutationAuthorityContractState> {
    return db.transaction(async (tx) => {
      const axes = await tx
        .select()
        .from(contractAxes)
        .orderBy(asc(contractAxes.axis))
      const effects = await tx
        .select({ effect: contractEffects.effect })
        .from(contractEffects)
        .orderBy(asc(contractEffects.sequence))
      const byName = new Map(axes.map((axis) => [axis.axis, axis]))
      const primary = byName.get(PRIMARY)
      const secondary = byName.get(SECONDARY)
      const rollback = byName.get(ROLLBACK)
      if (!primary || !secondary || !rollback) {
        throw new Error("Incomplete contract fixture state")
      }

      return {
        primary: primary.value,
        secondary: secondary.value,
        rollbackOnly: rollback.value,
        revisions: {
          primary: primary.revision,
          secondary: secondary.revision,
          rollbackOnly: rollback.revision,
        },
        effects: effects.map(({ effect }) => effect),
      }
    })
  }

  async function replaceState(next: MutationAuthorityContractState) {
    await db.transaction(async (tx) => {
      await tx.delete(contractEffects)
      if (next.effects.length > 0) {
        await tx
          .insert(contractEffects)
          .values(next.effects.map((effect) => ({ effect })))
      }
      await tx
        .update(contractAxes)
        .set({ value: next.primary, revision: next.revisions.primary })
        .where(eq(contractAxes.axis, PRIMARY))
      await tx
        .update(contractAxes)
        .set({ value: next.secondary, revision: next.revisions.secondary })
        .where(eq(contractAxes.axis, SECONDARY))
      await tx
        .update(contractAxes)
        .set({
          value: next.rollbackOnly,
          revision: next.revisions.rollbackOnly,
        })
        .where(eq(contractAxes.axis, ROLLBACK))
    })
  }

  const contention = new Array<number>()
  const attempts = new Map<string, number>()

  async function createDriver(): Promise<MutationAuthorityContractDriver> {
    await reset()
    contention.length = 0
    attempts.clear()

    const authority = createDrizzleMutationAuthority({
      db,
      scope: (actor: string) => actor,
      parseRejection(value): MutationAuthorityContractRejection {
        if (
          typeof value === "object" &&
          value !== null &&
          "code" in value &&
          (value.code === "precondition" ||
            value.code === "rejected-after-write")
        ) {
          return { code: value.code }
        }
        throw new Error("Invalid contract fixture rejection")
      },
    })
    const execute = async (envelope: unknown) => {
      const prepared = await prepareMutationRequest(
        mutationAuthorityContractProtocol,
        envelope
      )
      if (!prepared.ok) return prepared

      return executePreparedMutation({
        prepared: prepared.value,
        actor: MUTATION_AUTHORITY_CONTRACT_ACTOR,
        authority,
        async run(tx, stamp, rawArgs) {
          const args = rawArgs as MutationAuthorityContractArgs
          attempts.set(args.effect, (attempts.get(args.effect) ?? 0) + 1)
          if (serializationFailures > 0) {
            serializationFailures -= 1
            await tx.execute(
              sql.raw(
                "do $$ begin raise exception 'fixture serialization failure' using errcode = '40001'; end $$"
              )
            )
          }

          const rows = await tx.select().from(contractAxes)
          const byName = new Map(rows.map((axis) => [axis.axis, axis]))
          const primary = byName.get(PRIMARY)
          if (!primary) throw new Error("Missing primary contract axis")
          if (
            args.maximumPrimary !== null &&
            primary.value > args.maximumPrimary
          ) {
            return err({
              kind: "refused",
              error: { code: "precondition" },
            } as const)
          }

          const writes = args.axes.flatMap((requestedAxis) => {
            const axis =
              requestedAxis === "primary"
                ? PRIMARY
                : requestedAxis === "secondary"
                  ? SECONDARY
                  : ROLLBACK
            if (axis === ROLLBACK && primary.value !== 0) return []
            const current = byName.get(axis)
            if (!current) throw new Error(`Missing contract axis: ${axis}`)
            return [{ axis, current }]
          })

          await tx.insert(contractEffects).values({ effect: args.effect })
          if (
            args.behavior === "mutate-args-when-zero" &&
            primary.value === 0
          ) {
            const mutableArgs = args as { amount: number }
            mutableArgs.amount = 100
          }

          const externalDelta = contention.shift()
          if (externalDelta !== undefined) {
            await db
              .update(contractAxes)
              .set({
                value: sql`${contractAxes.value} + ${externalDelta}`,
                revision: sql`${contractAxes.revision} + 1`,
              })
              .where(eq(contractAxes.axis, PRIMARY))
          }

          for (const { axis, current } of writes) {
            const [written] = await tx
              .update(contractAxes)
              .set({
                value: current.value + args.amount,
                revision: current.revision + 1,
              })
              .where(
                and(
                  eq(contractAxes.axis, axis),
                  eq(contractAxes.revision, current.revision)
                )
              )
              .returning({ revision: contractAxes.revision })
            if (!written) throwMutationContention()

            const stampedAxis =
              axis === PRIMARY
                ? MUTATION_AUTHORITY_CONTRACT_AXES.primary
                : axis === SECONDARY
                  ? MUTATION_AUTHORITY_CONTRACT_AXES.secondary
                  : MUTATION_AUTHORITY_CONTRACT_AXES.rollback
            stamp.record(stampedAxis, requireRevision(written.revision))
          }

          if (args.behavior === "throw") {
            throw new Error("authority contract exception")
          }
          if (args.behavior === "reject") {
            return err({
              kind: "refused",
              error: { code: "rejected-after-write" },
            } as const)
          }
          return ok(undefined)
        },
      })
    }

    return {
      execute,
      read: readState,
      replace: replaceState,
      contendNext: async (primaryDelta = 0) => {
        contention.push(primaryDelta)
      },
      receiptCount: async () => db.$count(headcanonMutationReceipts),
      hasReceipt: async (mutationId) =>
        (await db.$count(
          headcanonMutationReceipts,
          and(
            eq(
              headcanonMutationReceipts.actorScope,
              MUTATION_AUTHORITY_CONTRACT_ACTOR
            ),
            eq(headcanonMutationReceipts.mutationId, mutationId)
          )
        )) === 1,
      attemptCount: async (mutationId) => {
        const [receipt] = await db
          .select({
            canonicalInvocation: headcanonMutationReceipts.canonicalInvocation,
          })
          .from(headcanonMutationReceipts)
          .where(eq(headcanonMutationReceipts.mutationId, mutationId))
        if (!receipt) return 0
        const canonical: unknown = JSON.parse(receipt.canonicalInvocation)
        if (
          typeof canonical !== "object" ||
          canonical === null ||
          !("invocation" in canonical)
        ) {
          throw new Error("Invalid contract receipt invocation")
        }
        const invocation = canonical.invocation
        if (
          typeof invocation !== "object" ||
          invocation === null ||
          !("args" in invocation)
        ) {
          throw new Error("Invalid contract receipt arguments")
        }
        const args = invocation.args
        if (
          typeof args !== "object" ||
          args === null ||
          !("effect" in args) ||
          typeof args.effect !== "string"
        ) {
          throw new Error("Invalid contract receipt effect")
        }
        return attempts.get(args.effect) ?? 0
      },
    }
  }

  verifyMutationAuthorityContract({
    name: "drizzle/Postgres",
    create: createDriver,
  })

  it("rolls back real Postgres serialization failures without a receipt", async () => {
    const driver = await createDriver()
    const envelope = contractEnvelope(
      100,
      contractArgs({ effect: "serialization" })
    )
    serializationFailures = 2

    await expect(driver.execute(envelope)).resolves.toEqual(
      err({ code: "contention", mutationId: envelope.mutationId })
    )
    expect(await driver.hasReceipt(envelope.mutationId)).toBe(false)
    expect(await driver.read()).toEqual(
      MUTATION_AUTHORITY_CONTRACT_INITIAL_STATE
    )

    await expect(driver.execute(envelope)).resolves.toMatchObject({ ok: true })
    expect(await driver.hasReceipt(envelope.mutationId)).toBe(true)
  })
})
