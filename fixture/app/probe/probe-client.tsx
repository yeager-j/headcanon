"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { startTransition, useOptimistic, useRef, useState } from "react"

import type { MutationEnvelope } from "@workspace/headcanon"

import type { addItem } from "@/lib/protocol"

import { applyFixtureMutation } from "../actions"

/**
 * UNN-682 probes, one per delivery shape. Each "mutate" adds an optimistic
 * item inside an async Action that is HELD OPEN until "release all" — the
 * package's held-until-canonization lifetime, made manual so the probe can
 * observe whether the authoritative `revision` prop advances while Actions
 * are open. No headcanon code is involved.
 *
 * Shapes:
 * - inside:  send invoked synchronously in the owning Action's first tick.
 * - effect:  send invoked later from a plain async context (setTimeout).
 * - fresh:   send invoked later inside a NEW startTransition's first tick.
 */
export function ProbeClient({
  items,
  revision,
  axis,
}: {
  items: readonly string[]
  revision: number
  axis: string
}) {
  const router = useRouter()
  const [frame, addOptimistic] = useOptimistic(
    items,
    (state: readonly string[], next: string) => [...state, next]
  )
  const holdersRef = useRef<Array<() => void>>([])
  const [log, setLog] = useState<readonly string[]>([])
  const counterRef = useRef(0)

  const append = (line: string) => setLog((current) => [...current, line])

  const hold = (): Promise<void> =>
    new Promise((resolve) => {
      holdersRef.current.push(resolve)
    })

  const envelopeFor = (
    text: string
  ): MutationEnvelope<ReturnType<typeof addItem>> => ({
    protocol: "fixture",
    mutationId: globalThis.crypto.randomUUID(),
    invocation: { name: "item.add", args: { text } },
  })

  const send = async (text: string, shape: string) => {
    const outcome = await applyFixtureMutation(envelopeFor(text))
    append(
      outcome.ok
        ? `${shape}:${text} accepted rev=${String(Object.values(outcome.value.revisions)[0])}`
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
        axis <code>{axis}</code>
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
      </dl>
    </main>
  )
}
