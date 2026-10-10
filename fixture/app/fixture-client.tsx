"use client"

import { FIXTURE_USER_ID } from "@/lib/actor"
import { addItem, fixtureProtocol, type FixtureState } from "@/lib/protocol"
import type { AcceptedStamp, Canon } from "headcanon"
import { createNextPredictedRoot } from "headcanon/next/client"
import type { MutationLifecycleError } from "headcanon/react"
import { useRouter } from "next/navigation"
import { startTransition, useState } from "react"
import type { Result } from "serializable-result"

import { applyFixtureMutation } from "./actions"

// The package's golden path: the generated Server Action implies the standard
// sender, and the App Router is the default refresh carrier.
const useFixturePredictions = createNextPredictedRoot({
  protocol: fixtureProtocol,
  scope: () => FIXTURE_USER_ID,
  action: applyFixtureMutation,
})

function describeAcceptance(
  result: Result<AcceptedStamp, MutationLifecycleError<string>>
): string {
  if (result.ok) return "accepted"
  const failure = result.error
  switch (failure.kind) {
    case "domain":
      return `refused: ${failure.error}`
    case "undeliverable":
      return `undeliverable: ${failure.error.code}`
    default:
      return failure.kind
  }
}

/**
 * Renders both truths side by side: the predicted list the user sees and the
 * raw canon prop (proof the authoritative RSC payload landed in place). The
 * counters and notices are the lifecycle's observable surface. A held-open
 * Action presents as `pending` never returning to 0 while `canon-count` never
 * advances.
 */
export function FixtureClient({ canon }: { canon: Canon<FixtureState> }) {
  const router = useRouter()
  const [draft, setDraft] = useState("")
  const [refusal, setRefusal] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<string | null>(null)
  const [conflictLog, setConflictLog] = useState<readonly string[]>([])
  const [retryDelivery, setRetryDelivery] = useState<(() => void) | null>(null)
  const [retryRefresh, setRetryRefresh] = useState<(() => void) | null>(null)

  const root = useFixturePredictions({
    canon,
    recoveryListeners: {
      onDeliveryUncertain({ retry }) {
        setRetryDelivery(() => retry)
        return () => setRetryDelivery(null)
      },
      onFreshnessStalled({ retry }) {
        setRetryRefresh(() => retry)
        return () => setRetryRefresh(null)
      },
      onConflict(conflict) {
        setConflictLog((log) => [
          ...log,
          `${conflict.invocation.args.text}: ${conflict.error}`,
        ])
      },
    },
  })

  const submit = () => {
    if (draft.length === 0) return
    const prediction = root.mutate(addItem({ text: draft }), {
      onAcceptance: (result) => setOutcome(describeAcceptance(result)),
    })
    setRefusal(prediction.ok ? null : prediction.error)
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
      <button
        type="button"
        onClick={() => startTransition(() => router.refresh())}
      >
        Reload canon
      </button>
      {retryDelivery && (
        <p role="alert">
          Delivery is uncertain.{" "}
          <button type="button" onClick={retryDelivery}>
            Retry delivery
          </button>
        </p>
      )}
      {retryRefresh && (
        <p role="alert">
          Canon is not catching up.{" "}
          <button type="button" onClick={retryRefresh}>
            Retry refresh
          </button>
        </p>
      )}
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
        <dt>stall-reason</dt>
        <dd data-testid="stall-reason">
          {root.status.freshness === "stalled"
            ? root.status.stallReason
            : "none"}
        </dd>
        <dt>conflicts</dt>
        <dd data-testid="conflicts">{root.conflicts.length}</dd>
        <dt>conflict-log</dt>
        <dd data-testid="conflict-log">{conflictLog.join(" | ")}</dd>
        <dt>refusal</dt>
        <dd data-testid="refusal">{refusal ?? "none"}</dd>
        <dt>outcome</dt>
        <dd data-testid="outcome">{outcome ?? "none"}</dd>
      </dl>
    </main>
  )
}
