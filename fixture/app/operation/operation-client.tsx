"use client"

import { createItem, type CreatedItem } from "@/lib/operations"
import type { FixtureRefusal } from "@/lib/protocol"
import { createNextOperationHook } from "headcanon/next/client"
import {
  sessionStoragePersistence,
  type OperationAnswer,
  type OperationFailure,
  type OperationHandle,
  type OperationHookOptions,
} from "headcanon/react"
import { useRouter } from "next/navigation"
import { useState } from "react"

import { createFixtureItem, createFixtureItemAndRedirect } from "../actions"

const useCreateItem = createNextOperationHook({
  operation: createItem,
  action: createFixtureItem,
})

const useCreateItemWithServerRedirect = createNextOperationHook({
  operation: createItem,
  action: createFixtureItemAndRedirect,
})

type CreateItem = OperationHandle<typeof createItem>

function describeFailure(failure: OperationFailure<FixtureRefusal>): string {
  switch (failure.kind) {
    case "refused":
      return `refused: ${failure.error}`
    case "undeliverable":
      return `undeliverable: ${failure.error.code}`
    default:
      return failure.kind
  }
}

function describeAnswer(
  answer: OperationAnswer<CreatedItem, FixtureRefusal> | undefined
): string {
  if (!answer) return "none"
  return answer.ok
    ? `accepted: ${answer.value.index}`
    : describeFailure(answer.error)
}

/** Navigates to the created item from the client. */
function useNavigateOnSettled(): OperationHookOptions<typeof createItem> {
  const router = useRouter()
  return {
    persistence: sessionStoragePersistence("fixture-operation:client"),
    onSettled: (answer) => {
      if (answer.ok) router.push(`/items/${answer.value.index}`)
    },
  }
}

/**
 * Each redirect mode has its own hook factory, so each has its own
 * persistence key: a key belongs to one factory.
 */
export function OperationClient({
  redirect,
}: {
  redirect: "client" | "server"
}) {
  return redirect === "server" ? <ServerRedirectForm /> : <ClientRedirectForm />
}

function ClientRedirectForm() {
  return <OperationForm operation={useCreateItem(useNavigateOnSettled())} />
}

function ServerRedirectForm() {
  const operation = useCreateItemWithServerRedirect({
    persistence: sessionStoragePersistence("fixture-operation:server"),
  })
  return <OperationForm operation={operation} />
}

/**
 * The operation's observable surface: its status, the held arguments, the
 * last answer, and the result of the last `run` or `retry` call. The form
 * submits through a React form Action that awaits `run`.
 */
function OperationForm({ operation }: { operation: CreateItem }) {
  const [lastCall, setLastCall] = useState("none")

  async function submit(formData: FormData) {
    const outcome = await operation.run({ text: String(formData.get("text")) })
    setLastCall(outcome.ok ? "accepted" : describeFailure(outcome.error))
  }

  async function retry() {
    const outcome = await operation.retry()
    setLastCall(outcome.ok ? "accepted" : describeFailure(outcome.error))
  }

  return (
    <main>
      <form action={submit}>
        <label>
          Item text
          <input name="text" defaultValue={operation.pending?.args.text} />
        </label>
        <button type="submit">Create</button>
      </form>
      <p>
        Status: <span data-testid="operation-status">{operation.status}</span>
      </p>
      <p>
        Pending:{" "}
        <span data-testid="operation-pending">
          {operation.pending
            ? `${operation.pending.args.text}${operation.pending.restored ? " (restored)" : ""}`
            : ""}
        </span>
      </p>
      <p>
        Outcome:{" "}
        <span data-testid="operation-outcome">
          {describeAnswer(operation.outcome)}
        </span>
      </p>
      <p>
        Last call: <span data-testid="operation-last-call">{lastCall}</span>
      </p>
      {operation.status === "unconfirmed" && (
        <p>
          <button type="button" onClick={() => void retry()}>
            Retry
          </button>
          <button type="button" onClick={operation.discard}>
            Discard
          </button>
        </p>
      )}
    </main>
  )
}
