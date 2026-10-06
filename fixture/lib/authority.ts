import {
  defineCanon,
  type Canon,
  type MutationAuthorityAdapter,
} from "headcanon"
import { createMutationBinder } from "headcanon/next/server"
import {
  createInMemoryMutationAuthority,
  type InMemoryMutationAuthority,
  type InMemoryReader,
  type InMemoryTransaction,
} from "headcanon/testing"

import { ITEMS_AXIS, type FixtureState } from "./protocol"

/** What the fixture's authority stores: the items and the axis revision. */
export interface FixtureRecord {
  readonly items: readonly string[]
  readonly revision: number
}

/** The trusted actor. A `reader` is denied at screening. */
export interface FixtureActor {
  readonly id: string
  readonly role: "editor" | "reader"
}

/**
 * Test-only switches that make the fixture misbehave on purpose, so the e2e
 * suite can reach the root's recovery surfaces deterministically.
 */
export interface FixtureFaults {
  /**
   * `fail`: delivery throws before the authority runs, so nothing commits.
   * `lose-response`: the authority commits and records its receipt, then
   * delivery throws, as if the response were lost.
   * `hang`: delivery waits until the faults are changed or reset.
   */
  readonly delivery: "none" | "fail" | "lose-response" | "hang"
  readonly role: FixtureActor["role"]
  /** When true, pages render the state captured when reads were frozen. */
  readonly freezeReads: boolean
}

const NO_FAULTS: FixtureFaults = {
  delivery: "none",
  role: "editor",
  freezeReads: false,
}

const EMPTY: FixtureRecord = { items: [], revision: 0 }

interface FixtureServer {
  authority: InMemoryMutationAuthority<FixtureRecord, FixtureActor, unknown>
  faults: FixtureFaults
  frozen: FixtureRecord | null
  releaseHungDeliveries: () => void
  hungDeliveries: Promise<void>
}

function createAuthority() {
  return createInMemoryMutationAuthority<FixtureRecord, FixtureActor, unknown>({
    initialState: EMPTY,
    scope: (actor) => actor.id,
  })
}

function gate(): Pick<
  FixtureServer,
  "hungDeliveries" | "releaseHungDeliveries"
> {
  let release = () => {}
  const hungDeliveries = new Promise<void>((resolve) => {
    release = resolve
  })
  return { hungDeliveries, releaseHungDeliveries: release }
}

function freshServer(): FixtureServer {
  return {
    authority: createAuthority(),
    faults: NO_FAULTS,
    frozen: null,
    ...gate(),
  }
}

// Stashed on `globalThis` so module duplication across Next's server bundles
// cannot mint a second authority.
const globalStore = globalThis as { __headcanonFixture?: FixtureServer }

function server(): FixtureServer {
  return (globalStore.__headcanonFixture ??= freshServer())
}

/**
 * The authority the Server Action uses: the package's in-memory authority,
 * reached through the current {@link server} so a reset can replace it, plus
 * the delivery faults. Receipts, deduplication, contention retry, and stamps
 * all stay the package's.
 */
export const fixtureAuthority: MutationAuthorityAdapter<
  InMemoryTransaction<FixtureRecord>,
  FixtureActor,
  unknown,
  InMemoryReader<FixtureRecord>
> = {
  get preflight() {
    return server().authority.preflight
  },
  async execute(request, run) {
    // Read once: a delivery released by a reset must not reach the new
    // authority.
    const { faults, authority, hungDeliveries } = server()
    if (faults.delivery === "fail") {
      throw new Error("fixture fault: delivery failed before the authority")
    }
    if (faults.delivery === "hang") await hungDeliveries
    const outcome = await authority.execute(request, run)
    if (faults.delivery === "lose-response") {
      throw new Error("fixture fault: response lost after the commit")
    }
    return outcome
  },
}

/** The actor the Server Action trusts. It never rides the wire. */
export function fixtureActor(): FixtureActor {
  return { id: "fixture-user", role: server().faults.role }
}

/**
 * Binds the fixture's commands to {@link fixtureActor} and
 * {@link fixtureAuthority}. The Server Action takes this same binder.
 */
export const fixtureBinder = createMutationBinder({
  actor: fixtureActor,
  authority: fixtureAuthority,
})

/** The canon a page renders: committed state, or the frozen read. */
export function readFixtureCanon(): Canon<FixtureState> {
  const { frozen, authority } = server()
  const record = frozen ?? authority.read()
  return defineCanon({
    value: { items: [...record.items] },
    revisions: { [ITEMS_AXIS]: record.revision },
  })
}

/** Committed state and receipt count, for test assertions. */
export function inspectFixtureAuthority() {
  const { authority } = server()
  return { ...authority.read(), receipts: authority.receiptCount() }
}

/** Commits an item as another writer would, outside any Server Action. */
export function writeAsAnotherClient(text: string): void {
  const { authority } = server()
  const current = authority.read()
  authority.replace({
    items: [...current.items, text],
    revision: current.revision + 1,
  })
}

/** Replaces the faults. Any change releases deliveries held by `hang`. */
export function setFixtureFaults(next: Partial<FixtureFaults>): void {
  const current = server()
  current.releaseHungDeliveries()
  Object.assign(current, gate())
  current.faults = { ...NO_FAULTS, ...next }
  current.frozen = current.faults.freezeReads ? current.authority.read() : null
}

/** Test isolation: an empty authority with no receipts and no faults. */
export function resetFixture(): void {
  server().releaseHungDeliveries()
  globalStore.__headcanonFixture = freshServer()
}
