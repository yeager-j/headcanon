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
import { err, ok, type Result } from "serializable-result"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  createDrizzleMutationAuthority,
  type DrizzleMutationAuthority,
  type DrizzleMutationTransaction,
} from "."
import {
  checkDeliveryAge,
  DEFAULT_RECEIPT_CLEANUP_MARGIN_MS,
  deliveryAgePolicy,
  executePreparedMutation,
  prepareMutationRequest,
  receiptKey,
  receiptRetentionMs,
  throwMutationContention,
  type MutationAcceptance,
  type MutationAttemptFailure,
} from "../core/authority"
import { defineMutation, defineProtocol } from "../core/protocol"
import {
  MUTATION_AUTHORITY_CONTRACT_AXES,
  MUTATION_AUTHORITY_CONTRACT_INITIAL_STATE,
  verifyMutationAuthorityContract,
  type MutationAuthorityContractAxis,
  type MutationAuthorityContractHarness,
  type MutationAuthorityContractRefusal,
  type MutationAuthorityContractState,
} from "../testing/suites/authority-contract"
import { deleteReceiptsOlderThan } from "./authority"
import { headcanonMutationReceipts } from "./schema"

const databaseUrl =
  process.env.HEADCANON_TEST_DATABASE_URL ?? process.env.DATABASE_URL
const receiptMigration = readFileSync(
  new URL(
    "../../drizzle/0000_headcanon_mutation_receipts.sql",
    import.meta.url
  ),
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
  getDatabase: () => ContractDatabase,
  isolation: IsolationLevel
): MutationAuthorityContractHarness<ContractTransaction, ContractDatabase> {
  return {
    name: `drizzle/Postgres (database default ${isolation})`,
    async create() {
      const database = getDatabase()
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

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const WINDOW_ACTOR = "window-actor"

/** A window small enough to place envelopes a minute either side of its bounds. */
const HOUR_WINDOW = Object.freeze({
  maxDeliveryAgeMs: HOUR_MS,
  clockSkewToleranceMs: 10 * MINUTE_MS,
})

type WindowAuthority = DrizzleMutationAuthority<
  NodePgQueryResultHKT,
  typeof schema,
  string,
  unknown
>

type TouchEnvelope = ReturnType<typeof touchEnvelope>

type TouchRun = (
  tx: ContractTransaction
) => Promise<MutationAcceptance | MutationAttemptFailure<unknown>>

function windowAuthority(
  db: ContractDatabase,
  window: {
    readonly maxDeliveryAgeMs?: number
    readonly clockSkewToleranceMs?: number
  } = {}
): WindowAuthority {
  return createDrizzleMutationAuthority<
    NodePgQueryResultHKT,
    typeof schema,
    string,
    unknown
  >({ db, scope: (actor) => actor, ...window })
}

function touchEnvelope(sequence: number, createdAt: number) {
  return {
    protocol: touchProtocol.id,
    mutationId: `40000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`,
    createdAt,
    invocation: touch({ effect: `touch-${sequence}` }),
  }
}

function requireOk<Value>(result: Result<Value, unknown>): Value {
  if (!result.ok) throw new Error("Expected an admitted delivery")
  return result.value
}

/** Runs `envelope` through the action's admission and execution path. */
async function deliver(
  authority: WindowAuthority,
  envelope: TouchEnvelope,
  run: TouchRun
) {
  const prepared = await prepareMutationRequest(touchProtocol, envelope)
  if (!prepared.ok) throw new Error("Invalid delivery-window envelope")

  return executePreparedMutation({
    prepared: prepared.value,
    actor: WINDOW_ACTOR,
    authority,
    run: (tx) => run(tx),
  })
}

/** A command that appends one effect and counts the attempts that ran it. */
function countingTouch(effect: string) {
  const counter = { attempts: 0 }
  const run: TouchRun = async (tx) => {
    counter.attempts += 1
    await tx.insert(contractEffects).values({ effect })
    return { kind: "accepted", unchanged: true }
  }

  return { counter, run }
}

/** The database clock in whole epoch milliseconds, as the adapter reads it. */
async function databaseClockMs(db: ContractDatabase): Promise<number> {
  const result = await db.execute<{ now_ms: number }>(
    sql`select (extract(epoch from date_trunc('milliseconds', clock_timestamp())) * 1000)::float8 as now_ms`
  )
  return Number(result.rows[0]?.now_ms)
}

async function receiptCreatedAtMs(
  db: ContractDatabase,
  mutationId: string
): Promise<number> {
  const result = await db.execute<{ created_ms: number }>(
    sql`select (extract(epoch from created_at) * 1000)::float8 as created_ms from ${headcanonMutationReceipts} where mutation_id = ${mutationId}`
  )
  return Number(result.rows[0]?.created_ms)
}

/** Moves a receipt's timestamp `shiftMs` into the past, as if time had passed. */
async function backdateReceipt(
  db: ContractDatabase,
  mutationId: string,
  shiftMs: number
): Promise<void> {
  await db.execute(
    sql`update ${headcanonMutationReceipts} set created_at = created_at - ${shiftMs}::float8 * interval '1 millisecond' where mutation_id = ${mutationId}`
  )
}

async function waitFor(
  condition: () => Promise<boolean>,
  what: string,
  timeoutMs = 5000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function waitForDatabaseClock(
  db: ContractDatabase,
  afterMs: number
): Promise<void> {
  await waitFor(
    async () => (await databaseClockMs(db)) > afterMs,
    `the database clock to pass ${afterMs}`
  )
}

/** Sessions in this database waiting on a lock of `kind` in a matching query. */
async function lockWaiters(
  db: ContractDatabase,
  kind: "advisory" | "row",
  queryPattern: string
): Promise<number> {
  const waitEvents =
    kind === "advisory" ? sql`('advisory')` : sql`('transactionid', 'tuple')`
  const result = await db.execute<{ waiting: number }>(
    sql`select count(*)::int as waiting from pg_stat_activity
      where datname = current_database()
        and wait_event_type = 'Lock'
        and wait_event in ${waitEvents}
        and query like ${queryPattern}`
  )
  return Number(result.rows[0]?.waiting ?? 0)
}

async function waitForLockWaiter(
  db: ContractDatabase,
  kind: "advisory" | "row",
  queryPattern: string
): Promise<void> {
  await waitFor(
    async () => (await lockWaiters(db, kind, queryPattern)) > 0,
    `a session waiting on a ${kind} lock`
  )
}

/** Opens a transaction on its own connection that the test commits. */
async function holdTransaction(pool: Pool) {
  const client = await pool.connect()
  await client.query("begin")

  return {
    client,
    db: drizzle(client, { schema }),
    async commit() {
      try {
        await client.query("commit")
      } finally {
        client.release()
      }
    },
  }
}

async function withTimeout<Value>(
  promise: Promise<Value>,
  timeoutMs: number,
  message: string
): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** Delivers envelopes a minute inside and outside each bound of HOUR_WINDOW. */
async function hourWindowOutcomes(
  db: ContractDatabase,
  authority: WindowAuthority,
  firstSequence: number
) {
  const now = await databaseClockMs(db)
  const createdAts = [
    now - HOUR_MS + MINUTE_MS,
    now - HOUR_MS - MINUTE_MS,
    now + 10 * MINUTE_MS - MINUTE_MS,
    now + 10 * MINUTE_MS + MINUTE_MS,
  ]
  const outcomes: string[] = []

  for (const [index, createdAt] of createdAts.entries()) {
    const envelope = touchEnvelope(firstSequence + index, createdAt)
    const outcome = await deliver(
      authority,
      envelope,
      countingTouch("window").run
    )
    outcomes.push(outcome.ok ? outcome.value.kind : outcome.error.code)
  }

  return outcomes
}

/**
 * Delivers an envelope that expires 1.5 s from now under a 3 s window. The
 * first attempt waits until the database clock passes its expiry, then
 * loses a race.
 */
async function expireDuringContendedAttempt(
  db: ContractDatabase,
  authority: WindowAuthority,
  sequence: number
) {
  const maxDeliveryAgeMs = 3000
  const now = await databaseClockMs(db)
  const envelope = touchEnvelope(sequence, now - maxDeliveryAgeMs + 1500)
  let attempts = 0

  const outcome = await deliver(authority, envelope, async (tx) => {
    attempts += 1
    if (attempts === 1) {
      await waitForDatabaseClock(db, envelope.createdAt + maxDeliveryAgeMs)
      throwMutationContention()
    }
    await tx.insert(contractEffects).values({ effect: "retried" })
    return { kind: "accepted", unchanged: true }
  })

  return { outcome, attempts, mutationId: envelope.mutationId }
}

describe.skipIf(!databaseUrl)("Drizzle/Postgres mutation authority", () => {
  const schemaName = `headcanon_${process.pid}_${Date.now()}`
  let adminPool: Pool | undefined
  const pools = new Map<IsolationLevel, Pool>()
  const databases = new Map<IsolationLevel, ContractDatabase>()
  let schemaCreated = false

  const databaseFor = (isolation: IsolationLevel) => {
    const db = databases.get(isolation)
    if (!db) throw new Error(`No database for ${isolation}`)
    return db
  }

  const readCommittedPool = () => {
    const pool = pools.get("read committed")
    if (!pool) throw new Error("No read committed pool")
    return pool
  }

  const emptyDatabase = async () => {
    const db = databaseFor("read committed")
    await db.delete(headcanonMutationReceipts)
    await db.delete(contractEffects)
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

    const db = databaseFor("read committed")
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
      const result = await databaseFor(isolation).execute<{
        default_transaction_isolation: string
      }>(sql`show default_transaction_isolation`)
      expect(result.rows[0]?.default_transaction_isolation).toBe(isolation)
    }
  })

  for (const isolation of DATABASE_ISOLATION_LEVELS) {
    verifyMutationAuthorityContract(
      contractHarness(() => databaseFor(isolation), isolation)
    )
  }

  it("rolls back real Postgres serialization failures without a receipt", async () => {
    const db = databaseFor("read committed")
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
        createdAt: Date.now(),
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
          return { kind: "accepted", unchanged: true }
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
  describe("delivery window", () => {
    const defaultRetentionMs = receiptRetentionMs(
      deliveryAgePolicy({}),
      DEFAULT_RECEIPT_CLEANUP_MARGIN_MS
    )

    it("applies a configured window on the database clock", async () => {
      const db = await emptyDatabase()

      expect(
        await hourWindowOutcomes(db, windowAuthority(db, HOUR_WINDOW), 100)
      ).toEqual([
        "accepted",
        "delivery-expired",
        "accepted",
        "delivery-from-future",
      ])
    })

    it("admits the same envelopes under the default window, so the window test depends on the options", async () => {
      const db = await emptyDatabase()

      expect(await hourWindowOutcomes(db, windowAuthority(db), 110)).toEqual([
        "accepted",
        "accepted",
        "accepted",
        "accepted",
      ])
    })

    it("checks the window again before each contention attempt", async () => {
      const db = await emptyDatabase()
      const authority = windowAuthority(db, { maxDeliveryAgeMs: 3000 })

      const { outcome, attempts, mutationId } =
        await expireDuringContendedAttempt(db, authority, 120)

      expect(outcome).toEqual(err({ code: "delivery-expired", mutationId }))
      expect(attempts).toBe(1)
      expect(await db.$count(headcanonMutationReceipts)).toBe(0)
      expect(await db.$count(contractEffects)).toBe(0)
    })

    it("runs the second attempt when the window is checked once per delivery, so the retry test can fail", async () => {
      const db = await emptyDatabase()
      const authority = windowAuthority(db, { maxDeliveryAgeMs: 3000 })
      const policy = deliveryAgePolicy({ maxDeliveryAgeMs: 3000 })
      const checkedOncePerDelivery: WindowAuthority["execute"] = async (
        request,
        run
      ) => {
        const admitted = checkDeliveryAge(
          policy,
          request,
          await databaseClockMs(db)
        )
        if (!admitted.ok) return admitted

        return authority.execute(
          { ...request, createdAt: await databaseClockMs(db) },
          run
        )
      }

      const { outcome, attempts } = await expireDuringContendedAttempt(
        db,
        { ...authority, execute: checkedOncePerDelivery },
        121
      )

      expect(outcome).toMatchObject({ ok: true, value: { kind: "accepted" } })
      expect(attempts).toBe(2)
    })

    it("judges a delivery that waited on its lock by the clock after the wait", async () => {
      const db = await emptyDatabase()
      const maxDeliveryAgeMs = 3000
      const authority = windowAuthority(db, { maxDeliveryAgeMs })
      const envelope = touchEnvelope(
        130,
        (await databaseClockMs(db)) - maxDeliveryAgeMs + 1500
      )
      const expiresAt = envelope.createdAt + maxDeliveryAgeMs
      const { counter, run } = countingTouch("waited")
      const held = await holdTransaction(readCommittedPool())
      let delivery: ReturnType<typeof deliver> | undefined

      try {
        await held.client.query(
          "select pg_advisory_xact_lock(hashtextextended($1, 0))",
          [receiptKey(WINDOW_ACTOR, envelope.mutationId)]
        )
        delivery = deliver(authority, envelope, run)
        await waitForLockWaiter(db, "advisory", "%pg_advisory_xact_lock%")

        // The delivery's transaction began inside the window, so a clock
        // read at transaction start would admit it.
        expect(await databaseClockMs(db)).toBeLessThan(expiresAt)
        await waitForDatabaseClock(db, expiresAt)
      } finally {
        await held.commit()
      }

      expect(await delivery).toEqual(
        err({ code: "delivery-expired", mutationId: envelope.mutationId })
      )
      expect(counter.attempts).toBe(0)
      expect(await db.$count(headcanonMutationReceipts)).toBe(0)
      expect(await db.$count(contractEffects)).toBe(0)
    })

    it("timestamps a receipt with the clock reading after its lock wait", async () => {
      const db = await emptyDatabase()
      const authority = windowAuthority(db)
      const envelope = touchEnvelope(131, await databaseClockMs(db))
      const held = await holdTransaction(readCommittedPool())
      let delivery: ReturnType<typeof deliver> | undefined
      let blockedAt = Number.POSITIVE_INFINITY

      try {
        await held.client.query(
          "select pg_advisory_xact_lock(hashtextextended($1, 0))",
          [receiptKey(WINDOW_ACTOR, envelope.mutationId)]
        )
        delivery = deliver(authority, envelope, countingTouch("stamped").run)
        await waitForLockWaiter(db, "advisory", "%pg_advisory_xact_lock%")
        blockedAt = await databaseClockMs(db)
        await waitForDatabaseClock(db, blockedAt + 100)
      } finally {
        await held.commit()
      }

      expect(await delivery).toMatchObject({
        ok: true,
        value: { kind: "accepted" },
      })
      // The column default, now(), is the transaction start: before blockedAt.
      expect(await receiptCreatedAtMs(db, envelope.mutationId)).toBeGreaterThan(
        blockedAt
      )
    })

    it("skips a receipt row a lookup has locked and leaves it to replay", async () => {
      const db = await emptyDatabase()
      const authority = windowAuthority(db)
      const envelope = touchEnvelope(132, await databaseClockMs(db))
      const { counter, run } = countingTouch("locked")
      const first = await deliver(authority, envelope, run)
      await backdateReceipt(
        db,
        envelope.mutationId,
        defaultRetentionMs + HOUR_MS
      )
      const held = await holdTransaction(readCommittedPool())
      let deleted: number | undefined

      try {
        // The lookup a redelivery makes before it replays.
        await held.db
          .select()
          .from(headcanonMutationReceipts)
          .where(eq(headcanonMutationReceipts.mutationId, envelope.mutationId))
          .for("update")
        deleted = await withTimeout(
          authority.deleteExpiredReceipts(),
          2000,
          "Cleanup waited on a locked receipt instead of skipping it"
        )
      } finally {
        await held.commit()
      }

      expect(deleted).toBe(0)
      expect(await deliver(authority, envelope, run)).toEqual(first)
      expect(counter.attempts).toBe(1)
      expect(await db.$count(contractEffects)).toBe(1)
    })

    it("refuses a redelivery whose lookup waited on cleanup's delete", async () => {
      const db = await emptyDatabase()
      const authority = windowAuthority(db)
      const envelope = touchEnvelope(133, await databaseClockMs(db))
      requireOk(await deliver(authority, envelope, countingTouch("once").run))
      const shiftMs = defaultRetentionMs + HOUR_MS
      await backdateReceipt(db, envelope.mutationId, shiftMs)
      const redelivered = {
        ...envelope,
        createdAt: envelope.createdAt - shiftMs,
      }
      const { counter, run } = countingTouch("again")
      const held = await holdTransaction(readCommittedPool())
      let redelivery: ReturnType<typeof deliver> | undefined

      try {
        expect(
          await deleteReceiptsOlderThan(held.db, defaultRetentionMs, 10)
        ).toBe(1)
        redelivery = deliver(authority, redelivered, run)
        await waitForLockWaiter(db, "row", "%headcanon_mutation_receipts%")
      } finally {
        await held.commit()
      }

      expect(await redelivery).toEqual(
        err({ code: "delivery-expired", mutationId: envelope.mutationId })
      )
      expect(counter.attempts).toBe(0)
      expect(await db.$count(headcanonMutationReceipts)).toBe(0)
      expect(await db.$count(contractEffects)).toBe(1)
    })

    it("keeps an admitted fast-clock receipt through the age plus the skew tolerance", async () => {
      const db = await emptyDatabase()
      const authority = windowAuthority(db, HOUR_WINDOW)
      const fastClock =
        (await databaseClockMs(db)) +
        HOUR_WINDOW.clockSkewToleranceMs -
        MINUTE_MS
      const envelope = touchEnvelope(134, fastClock)
      const { counter, run } = countingTouch("fast-clock")
      const first = await deliver(authority, envelope, run)
      requireOk(first)

      // Move the receipt and the envelope back together, to two minutes
      // before age plus skew: the envelope is still inside the window.
      const shiftMs =
        HOUR_WINDOW.maxDeliveryAgeMs +
        HOUR_WINDOW.clockSkewToleranceMs -
        2 * MINUTE_MS
      await backdateReceipt(db, envelope.mutationId, shiftMs)
      const redelivered = {
        ...envelope,
        createdAt: envelope.createdAt - shiftMs,
      }

      expect(await authority.deleteExpiredReceipts({ marginMs: 0 })).toBe(0)
      expect(await deliver(authority, redelivered, run)).toEqual(first)
      expect(counter.attempts).toBe(1)

      // Negative control: retention without the skew tolerance deletes the
      // receipt, and the same redelivery runs the command again.
      expect(
        await deleteReceiptsOlderThan(db, HOUR_WINDOW.maxDeliveryAgeMs, 10)
      ).toBe(1)
      requireOk(await deliver(authority, redelivered, run))
      expect(counter.attempts).toBe(2)
      expect(await db.$count(contractEffects)).toBe(2)
    })

    it("deletes expired receipts oldest first, a batch at a time", async () => {
      const db = await emptyDatabase()
      const authority = windowAuthority(db)
      const now = await databaseClockMs(db)
      const oldest = touchEnvelope(140, now)
      const older = touchEnvelope(141, now)
      const fresh = touchEnvelope(142, now)
      for (const envelope of [oldest, older, fresh]) {
        requireOk(
          await deliver(authority, envelope, countingTouch("batch").run)
        )
      }
      await backdateReceipt(
        db,
        oldest.mutationId,
        defaultRetentionMs + 2 * HOUR_MS
      )
      await backdateReceipt(db, older.mutationId, defaultRetentionMs + HOUR_MS)

      expect(await authority.deleteExpiredReceipts({ limit: 1 })).toBe(1)
      const remaining = await db
        .select({ mutationId: headcanonMutationReceipts.mutationId })
        .from(headcanonMutationReceipts)
        .orderBy(asc(headcanonMutationReceipts.mutationId))
      expect(remaining.map(({ mutationId }) => mutationId)).toEqual([
        older.mutationId,
        fresh.mutationId,
      ])

      expect(await authority.deleteExpiredReceipts({ limit: 1 })).toBe(1)
      expect(await authority.deleteExpiredReceipts({ limit: 1 })).toBe(0)
      expect(await db.$count(headcanonMutationReceipts)).toBe(1)
    })
  })
})
