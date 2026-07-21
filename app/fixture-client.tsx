"use client"

import { useState } from "react"

import type { Canon } from "@workspace/headcanon"
import {
  createNextPredictedRoot,
  useRouterRefresh,
} from "@workspace/headcanon/next/client"

import { addItem, fixtureProtocol, type FixtureState } from "@/lib/protocol"

import { applyFixtureMutation } from "./actions"

const useFixturePredictions = createNextPredictedRoot({
  protocol: fixtureProtocol,
  send: applyFixtureMutation,
  refresh: useRouterRefresh,
})

/**
 * Renders both truths side by side: `value` (the predicted projection the
 * user sees) and the raw canon prop (proof the authoritative RSC payload
 * actually landed in place). The lifecycle counters are the contract's
 * observable surface — the deadlock this fixture exists to catch presents as
 * `pending` never returning to 0 while `canon-count` never advances.
 */
export function FixtureClient({ canon }: { canon: Canon<FixtureState> }) {
  const root = useFixturePredictions({ canon })
  const [draft, setDraft] = useState("")
  const [refusal, setRefusal] = useState<string | null>(null)

  const submit = () => {
    if (draft.length === 0) return
    const receipt = root.mutate(addItem({ text: draft }))
    setRefusal(receipt.ok ? null : receipt.error)
    setDraft("")
  }

  return (
    <main>
      <h1>Headcanon fixture</h1>
      <input
        aria-label="New item"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <button type="button" onClick={submit}>
        Add
      </button>
      <ul data-testid="items">
        {root.value.items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <dl>
        <dt>canon-count</dt>
        <dd data-testid="canon-count">{canon.value.items.length}</dd>
        <dt>pending</dt>
        <dd data-testid="pending">{root.status.pending}</dd>
        <dt>delivery</dt>
        <dd data-testid="delivery">{root.status.delivery}</dd>
        <dt>freshness</dt>
        <dd data-testid="freshness">{root.status.freshness}</dd>
        <dt>conflicts</dt>
        <dd data-testid="conflicts">{root.conflicts.length}</dd>
        <dt>refusal</dt>
        <dd data-testid="refusal">{refusal ?? "none"}</dd>
      </dl>
    </main>
  )
}
