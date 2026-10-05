import type { AcceptedStamp } from "@workspace/headcanon"

/**
 * The fixture's whole authority: one in-memory collection plus the receipt
 * ledger keyed by mutation ID (duplicate redelivery returns the recorded
 * stamp, never reruns the append). Stashed on `globalThis` so dev-mode module
 * duplication cannot mint a second authority.
 */
interface FixtureAuthority {
  items: string[]
  revision: number
  receipts: Map<string, AcceptedStamp>
}

const globalStore = globalThis as { __headcanonFixture?: FixtureAuthority }

export const authority: FixtureAuthority = (globalStore.__headcanonFixture ??= {
  items: [],
  revision: 0,
  receipts: new Map(),
})

export function resetAuthority(): void {
  authority.items = []
  authority.revision = 0
  authority.receipts = new Map()
}
