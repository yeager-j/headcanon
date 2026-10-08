"use client"

import { addItem, fixtureProtocol, ITEMS_AXIS } from "@/lib/protocol"
import { revisionAt, type MutationEnvelope } from "headcanon"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { startTransition, useOptimistic, useRef, useState } from "react"

import { applyFixtureMutation } from "../actions"

/**
 * UNN-682 probes, one per delivery shape. Each "mutate" adds an optimistic
 * item inside an async Action that is HELD OPEN until "release all", so the
 * probe can observe whether the authoritative `revision` prop advances while
 * Actions are open. The package holds one such Action per delivery attempt,
 * until the attempt is answered or `DELIVERY_WAIT_MS` passes; here the hold
 * is manual. No headcanon client code is involved: the probe calls the
 * generated Server Action directly, with an envelope built from the protocol
 * definition.
 *
 * Shapes:
 * - inside:  send invoked synchronously in the owning Action's first tick.
 * - effect:  send invoked later from a plain async context (setTimeout).
 * - fresh:   send invoked later inside a NEW startTransition's first tick.
 */
export function ProbeClient({
  items,
  revision,
}: {
  items: readonly string[]
  revision: number
}) {
  const router = useRouter()
  const [frame, addOptimistic] = useOptimistic(
    items,
    (state: readonly string[], next: string) => [...state, next]
  )
  const holdersRef = useRef<Array<() => void>>([])
  const [log, setLog] = useState<readonly string[]>([])
  const counterRef = useRef(0)
  const [bumps, setBumps] = useState(0)

  const append = (line: string) => setLog((current) => [...current, line])

  const hold = (): Promise<void> =>
    new Promise((resolve) => {
      holdersRef.current.push(resolve)
    })

  const envelopeFor = (
    text: string
  ): MutationEnvelope<ReturnType<typeof addItem>> => ({
    protocol: fixtureProtocol.id,
    mutationId: globalThis.crypto.randomUUID(),
    createdAt: Date.now(),
    invocation: addItem({ text }),
  })

  const send = async (text: string, shape: string) => {
    const outcome = await applyFixtureMutation(envelopeFor(text))
    append(
      outcome.ok && outcome.value.kind === "accepted"
        ? `${shape}:${text} accepted rev=${String(revisionAt(outcome.value.stamp.revisions, ITEMS_AXIS))}`
        : `${shape}:${text} rejected`
    )
  }

  const mutateInside = () => {
    const text = `inside-${++counterRef.current}`
    startTransition(async () => {
      addOptimistic(text)
      await send(text, "inside")
      await hold()
    })
  }

  const mutateEffect = () => {
    const text = `effect-${++counterRef.current}`
    startTransition(async () => {
      addOptimistic(text)
      await hold()
    })
    setTimeout(() => {
      void send(text, "effect")
    }, 50)
  }

  const mutateFresh = () => {
    const text = `fresh-${++counterRef.current}`
    startTransition(async () => {
      addOptimistic(text)
      await hold()
    })
    setTimeout(() => {
      startTransition(async () => {
        await send(text, "fresh")
      })
    }, 50)
  }

  // No Action and no optimistic state: only the Server Action call itself.
  const sendBare = () => {
    const text = `bare-${++counterRef.current}`
    void send(text, "bare")
  }

  const bump = () => {
    startTransition(() => setBumps((count) => count + 1))
  }

  const releaseOne = () => {
    const release = holdersRef.current.shift()
    release?.()
    append("released one")
  }

  const releaseAll = () => {
    const holders = holdersRef.current
    holdersRef.current = []
    for (const release of holders) release()
    append(`released ${holders.length}`)
  }

  const refreshRouter = () => {
    startTransition(() => {
      router.refresh()
      append("router.refresh requested")
    })
  }

  return (
    <main>
      <h1>Probe</h1>
      <div>
        axis <code>{ITEMS_AXIS}</code>
      </div>
      <button type="button" onClick={mutateInside}>
        mutate inside
      </button>
      <button type="button" onClick={mutateEffect}>
        mutate effect
      </button>
      <button type="button" onClick={mutateFresh}>
        mutate fresh
      </button>
      <button type="button" onClick={sendBare}>
        send bare
      </button>
      <button type="button" onClick={bump}>
        bump in a transition
      </button>
      <button type="button" onClick={releaseOne}>
        release one
      </button>
      <button type="button" onClick={releaseAll}>
        release all
      </button>
      <button type="button" onClick={refreshRouter}>
        router refresh
      </button>
      <Link href="/">go home</Link>
      <dl>
        <dt>revision</dt>
        <dd data-testid="revision">{revision}</dd>
        <dt>frame</dt>
        <dd data-testid="frame">{frame.join(",")}</dd>
        <dt>log</dt>
        <dd data-testid="log">{log.join(" | ")}</dd>
        <dt>bumps</dt>
        <dd data-testid="bumps">{bumps}</dd>
      </dl>
    </main>
  )
}
