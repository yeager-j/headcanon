// @vitest-environment jsdom

import type { StandardSchemaV1 } from "@standard-schema/spec"
import { act, renderHook } from "@testing-library/react"
import { StrictMode } from "react"
import { err, ok, type Result } from "serializable-result"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  DELIVERY_WAIT_MS,
  RetryableDeliveryError,
  sessionStoragePersistence,
  TerminalDeliveryError,
  type OperationHookOptions,
} from "."
import { defineOperation, type OperationEnvelope } from ".."
import { DELIVERY_RETRY_DELAYS_MS } from "./ledger"
import { createOperationHook } from "./operation"

type RunArgs = { readonly name: string }
type RunResult = { readonly runId: string }

const runArgs: StandardSchemaV1<unknown, RunArgs> = {
  "~standard": {
    version: 1,
    vendor: "headcanon-test",
    validate: (value) =>
      typeof (value as Partial<RunArgs> | null)?.name === "string"
        ? { value: value as RunArgs }
        : { issues: [{ message: "name must be a string" }] },
  },
}

const createRun = defineOperation({
  name: "test.run.create.v1",
  args: runArgs,
  result: {
    "~standard": {
      version: 1,
      vendor: "headcanon-test",
      validate: (value) => ({ value: value as RunResult }),
    },
  } satisfies StandardSchemaV1<unknown, RunResult>,
  refusal: {
    "~standard": {
      version: 1,
      vendor: "headcanon-test",
      validate: (value) => ({ value: value as "name-taken" }),
    },
  } satisfies StandardSchemaV1<unknown, "name-taken">,
})

type Envelope = OperationEnvelope<typeof createRun>
type Answer = Result<RunResult, "name-taken">

/** A sender whose calls stay open until the test answers them. */
function createDeferredSender() {
  const calls: Array<{
    readonly envelope: Envelope
    answer(value: Answer): Promise<void>
    fail(error: unknown): Promise<void>
  }> = []

  const send = vi.fn(
    (envelope: Envelope) =>
      new Promise<Answer>((resolve, reject) => {
        calls.push({
          envelope,
          answer: (value) => act(async () => resolve(value)),
          fail: (error) => act(async () => reject(error)),
        })
      })
  )

  return { send, calls }
}

class ControlFlowError extends Error {}

function rethrowControlFlow(error: unknown): void {
  if (error instanceof ControlFlowError) throw error
}

/** The receipt scope of the player signed in when a test does not say. */
const PLAYER_1 = "player-1"

function mountOperation(
  useOperation: ReturnType<typeof createOperationHook<typeof createRun>>,
  options: Partial<OperationHookOptions<typeof createRun>> = {}
) {
  return renderHook(() => useOperation({ scope: PLAYER_1, ...options }))
}

const PERSISTENCE_KEY = "new-run:player-1"

function storedEnvelopes(): unknown {
  const stored = globalThis.sessionStorage.getItem(PERSISTENCE_KEY)
  return stored === null ? undefined : JSON.parse(stored)
}

beforeEach(() => {
  globalThis.sessionStorage.clear()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("createOperationHook", () => {
  it("sends one envelope and settles with the result", async () => {
    const { send, calls } = createDeferredSender()
    const onSettled = vi.fn()
    const useOperation = createOperationHook({ operation: createRun, send })
    const { result } = mountOperation(useOperation, { onSettled })

    let outcome: Promise<unknown> = Promise.resolve()
    act(() => {
      outcome = result.current.run({ name: "Emerald" })
    })
    expect(result.current.status).toBe("sending")
    expect(result.current.pending).toEqual({
      args: { name: "Emerald" },
      restored: false,
      mayHaveCommitted: false,
    })

    expect(calls[0]!.envelope.scope).toBe(PLAYER_1)

    await calls[0]!.answer(ok({ runId: "run-1" }))

    expect(await outcome).toEqual(ok({ runId: "run-1" }))
    expect(send).toHaveBeenCalledTimes(1)
    expect(result.current.status).toBe("settled")
    expect(result.current.outcome).toEqual(ok({ runId: "run-1" }))
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(ok({ runId: "run-1" }))
  })

  it("joins the delivery for the same arguments and refuses other arguments", async () => {
    const { send, calls } = createDeferredSender()
    const useOperation = createOperationHook({ operation: createRun, send })
    const { result } = mountOperation(useOperation)

    let first: Promise<unknown> = Promise.resolve()
    let same: Promise<unknown> = Promise.resolve()
    let other: Promise<unknown> = Promise.resolve()
    act(() => {
      first = result.current.run({ name: "Emerald" })
      same = result.current.run({ name: "Emerald" })
      other = result.current.run({ name: "Ruby" })
    })

    expect(await other).toEqual(err({ kind: "pending-submission" }))
    await calls[0]!.answer(ok({ runId: "run-1" }))
    expect(await first).toEqual(ok({ runId: "run-1" }))
    expect(await same).toEqual(ok({ runId: "run-1" }))
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("holds a submission whose call failed and retries its exact envelope", async () => {
    const { send, calls } = createDeferredSender()
    const onSettled = vi.fn()
    const useOperation = createOperationHook({ operation: createRun, send })
    const { result } = mountOperation(useOperation, { onSettled })

    let outcome: Promise<unknown> = Promise.resolve()
    act(() => {
      outcome = result.current.run({ name: "Emerald" })
    })
    await calls[0]!.fail(new TypeError("Failed to fetch"))

    expect(await outcome).toEqual(
      err({ kind: "unconfirmed", mayHaveCommitted: true })
    )
    expect(result.current.status).toBe("unconfirmed")
    expect(result.current.pending?.mayHaveCommitted).toBe(true)

    act(() => {
      outcome = result.current.retry()
    })
    await calls[1]!.answer(ok({ runId: "run-1" }))

    expect(calls[1]!.envelope).toEqual(calls[0]!.envelope)
    expect(await outcome).toEqual(ok({ runId: "run-1" }))
    expect(onSettled).toHaveBeenCalledOnce()
  })

  it("resolves unconfirmed after the wait and settles a late answer once", async () => {
    const { calls, send } = createDeferredSender()
    const onSettled = vi.fn()
    const useOperation = createOperationHook({ operation: createRun, send })
    const { result } = mountOperation(useOperation, { onSettled })

    let outcome: Promise<unknown> = Promise.resolve()
    act(() => {
      outcome = result.current.run({ name: "Emerald" })
    })
    await act(async () => vi.advanceTimersByTime(DELIVERY_WAIT_MS))

    expect(await outcome).toEqual(
      err({ kind: "unconfirmed", mayHaveCommitted: true })
    )
    expect(result.current.status).toBe("unconfirmed")

    await calls[0]!.answer(ok({ runId: "run-1" }))

    expect(result.current.status).toBe("settled")
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(ok({ runId: "run-1" }))
  })

  it("resends the same envelope after contention", async () => {
    const { calls, send } = createDeferredSender()
    const useOperation = createOperationHook({ operation: createRun, send })
    const { result } = mountOperation(useOperation)

    let outcome: Promise<unknown> = Promise.resolve()
    act(() => {
      outcome = result.current.run({ name: "Emerald" })
    })
    await calls[0]!.fail(new RetryableDeliveryError())
    expect(result.current.status).toBe("sending")
    await act(async () => vi.advanceTimersByTime(DELIVERY_RETRY_DELAYS_MS[0]))
    await calls[1]!.answer(ok({ runId: "run-1" }))

    expect(calls[1]!.envelope).toBe(calls[0]!.envelope)
    expect(await outcome).toEqual(ok({ runId: "run-1" }))
  })

  it("settles a final failure and reports whether an earlier call may have committed", async () => {
    const { calls, send } = createDeferredSender()
    const useOperation = createOperationHook({ operation: createRun, send })
    const { result } = mountOperation(useOperation)

    let outcome: Promise<unknown> = Promise.resolve()
    act(() => {
      outcome = result.current.run({ name: "Emerald" })
    })
    await calls[0]!.fail(new TerminalDeliveryError({ kind: "denied" }))
    expect(await outcome).toEqual(
      err({ kind: "denied", mayHaveCommitted: false })
    )

    act(() => {
      outcome = result.current.run({ name: "Ruby" })
    })
    await calls[1]!.fail(new TypeError("Failed to fetch"))
    act(() => {
      outcome = result.current.retry()
    })
    await calls[2]!.fail(new TerminalDeliveryError({ kind: "denied" }))

    expect(await outcome).toEqual(
      err({ kind: "denied", mayHaveCommitted: true })
    )
    expect(calls[1]!.envelope.mutationId).not.toBe(
      calls[0]!.envelope.mutationId
    )
  })

  it("lets a discarded submission's answer change nothing", async () => {
    const { calls, send } = createDeferredSender()
    const onSettled = vi.fn()
    const useOperation = createOperationHook({ operation: createRun, send })
    const { result } = mountOperation(useOperation, {
      persistence: sessionStoragePersistence(PERSISTENCE_KEY),
      onSettled,
    })

    let first: Promise<unknown> = Promise.resolve()
    act(() => {
      first = result.current.run({ name: "Emerald" })
    })
    act(() => {
      result.current.discard()
      void result.current.run({ name: "Ruby" })
    })
    await calls[0]!.answer(ok({ runId: "run-1" }))

    expect(await first).toEqual(ok({ runId: "run-1" }))
    expect(onSettled).not.toHaveBeenCalled()
    expect(result.current.status).toBe("sending")
    expect(result.current.pending?.args).toEqual({ name: "Ruby" })
    expect(storedEnvelopes()).toEqual([calls[1]!.envelope])
  })

  it("resolves a discarded submission at its own deadline", async () => {
    const { calls, send } = createDeferredSender()
    const useOperation = createOperationHook({ operation: createRun, send })
    const { result } = mountOperation(useOperation)

    let first: Promise<unknown> = Promise.resolve()
    act(() => {
      first = result.current.run({ name: "Emerald" })
    })
    await act(async () => vi.advanceTimersByTime(1_000))
    act(() => {
      result.current.discard()
      void result.current.run({ name: "Ruby" })
    })
    await act(async () => vi.advanceTimersByTime(DELIVERY_WAIT_MS - 1_000))

    expect(await first).toEqual(
      err({ kind: "unconfirmed", mayHaveCommitted: true })
    )
    expect(result.current.status).toBe("sending")
    expect(calls).toHaveLength(2)
  })

  it("passes framework control flow on and ends the submission", async () => {
    const { calls, send } = createDeferredSender()
    const useOperation = createOperationHook(
      { operation: createRun, send },
      rethrowControlFlow
    )
    const { result } = mountOperation(useOperation, {
      persistence: sessionStoragePersistence(PERSISTENCE_KEY),
    })

    let outcome: Promise<unknown> = Promise.resolve()
    act(() => {
      outcome = result.current.run({ name: "Emerald" })
    })
    const settled = outcome.catch((error: unknown) => error)
    const redirect = new ControlFlowError("NEXT_REDIRECT")
    await calls[0]!.fail(redirect)

    expect(await settled).toBe(redirect)
    expect(result.current.status).toBe("idle")
    expect(storedEnvelopes()).toBeUndefined()
  })

  it("passes control flow that arrives after the wait to React", async () => {
    const redirect = new ControlFlowError("NEXT_REDIRECT")
    const propagated = vi.fn()
    const captureRedirect = (event: ErrorEvent) => {
      if (event.error !== redirect) return
      event.preventDefault()
      propagated(event.error)
    }
    window.addEventListener("error", captureRedirect)
    try {
      const { calls, send } = createDeferredSender()
      const useOperation = createOperationHook(
        { operation: createRun, send },
        rethrowControlFlow
      )
      const { result } = mountOperation(useOperation)

      let outcome: Promise<unknown> = Promise.resolve()
      act(() => {
        outcome = result.current.run({ name: "Emerald" })
      })
      await act(async () => vi.advanceTimersByTime(DELIVERY_WAIT_MS))
      expect(await outcome).toEqual(
        err({ kind: "unconfirmed", mayHaveCommitted: true })
      )

      await calls[0]!.fail(redirect)

      expect(propagated).toHaveBeenCalledWith(redirect)
      expect(result.current.status).toBe("idle")
    } finally {
      window.removeEventListener("error", captureRedirect)
    }
  })

  it("exposes frozen pending arguments", () => {
    const { send } = createDeferredSender()
    const useOperation = createOperationHook({ operation: createRun, send })
    const { result } = mountOperation(useOperation)

    act(() => {
      void result.current.run({ name: "Emerald" })
    })

    expect(Object.isFrozen(result.current.pending?.args)).toBe(true)
  })

  it("answers retry without a held submission without sending", async () => {
    const { send } = createDeferredSender()
    const useOperation = createOperationHook({ operation: createRun, send })
    const { result } = mountOperation(useOperation)

    expect(await result.current.retry()).toEqual(err({ kind: "no-submission" }))
    expect(send).not.toHaveBeenCalled()
  })
})

describe("operation persistence", () => {
  it("stores the envelope before the first send and clears it on the answer", async () => {
    const { calls, send } = createDeferredSender()
    const useOperation = createOperationHook({ operation: createRun, send })
    const { result } = mountOperation(useOperation, {
      persistence: sessionStoragePersistence(PERSISTENCE_KEY),
    })

    act(() => {
      void result.current.run({ name: "Emerald" })
    })
    expect(storedEnvelopes()).toEqual([calls[0]!.envelope])

    await calls[0]!.answer(err("name-taken"))
    expect(storedEnvelopes()).toBeUndefined()
    expect(result.current.outcome).toEqual(
      err({ kind: "refused", error: "name-taken" })
    )
  })

  it("restores a held submission with its own scope after a page load without sending it", async () => {
    const first = createDeferredSender()
    const persistence = sessionStoragePersistence(PERSISTENCE_KEY)
    const before = mountOperation(
      createOperationHook({ operation: createRun, send: first.send }),
      { persistence }
    )
    act(() => {
      void before.result.current.run({ name: "Emerald" })
    })
    const envelope = first.calls[0]!.envelope
    before.unmount()

    // A page load: a new module instance, the same session storage.
    const second = createDeferredSender()
    const onSettled = vi.fn()
    const { result } = mountOperation(
      createOperationHook({ operation: createRun, send: second.send }),
      { scope: "player-2", persistence, onSettled }
    )

    expect(result.current.status).toBe("unconfirmed")
    expect(result.current.pending).toEqual({
      args: { name: "Emerald" },
      restored: true,
      mayHaveCommitted: true,
    })
    expect(second.send).not.toHaveBeenCalled()

    act(() => {
      void result.current.retry()
    })
    await second.calls[0]!.answer(ok({ runId: "run-1" }))

    expect(second.calls[0]!.envelope).toEqual(envelope)
    expect(second.calls[0]!.envelope.scope).toBe(PLAYER_1)
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(ok({ runId: "run-1" }))
  })

  it("drops a stored value that is not one envelope of this operation", () => {
    globalThis.sessionStorage.setItem(
      PERSISTENCE_KEY,
      JSON.stringify([{ protocol: "headcanon:operation", mutationId: "x" }])
    )
    const { send } = createDeferredSender()
    const { result } = mountOperation(
      createOperationHook({ operation: createRun, send }),
      { persistence: sessionStoragePersistence(PERSISTENCE_KEY) }
    )

    expect(result.current.status).toBe("idle")
  })

  it("drops a stored envelope without a scope", () => {
    const first = createDeferredSender()
    const persistence = sessionStoragePersistence(PERSISTENCE_KEY)
    const before = mountOperation(
      createOperationHook({ operation: createRun, send: first.send }),
      { persistence }
    )
    act(() => {
      void before.result.current.run({ name: "Emerald" })
    })
    before.unmount()
    const { scope: _scope, ...unscoped } = first.calls[0]!.envelope
    globalThis.sessionStorage.setItem(
      PERSISTENCE_KEY,
      JSON.stringify([unscoped])
    )

    const { send } = createDeferredSender()
    const { result } = mountOperation(
      createOperationHook({ operation: createRun, send }),
      { persistence }
    )

    expect(result.current.status).toBe("idle")
  })

  it("continues one submission across remounts with the same key", async () => {
    const { calls, send } = createDeferredSender()
    const useOperation = createOperationHook({ operation: createRun, send })
    const persistence = sessionStoragePersistence(PERSISTENCE_KEY)
    const firstSettled = vi.fn()
    const first = mountOperation(useOperation, {
      persistence,
      onSettled: firstSettled,
    })
    act(() => {
      void first.result.current.run({ name: "Emerald" })
    })
    first.unmount()

    const secondSettled = vi.fn()
    const { result } = mountOperation(useOperation, {
      persistence,
      onSettled: secondSettled,
    })
    expect(result.current.status).toBe("sending")

    act(() => {
      result.current.discard()
      void result.current.run({ name: "Ruby" })
    })
    await calls[0]!.answer(ok({ runId: "run-1" }))

    expect(firstSettled).not.toHaveBeenCalled()
    expect(secondSettled).not.toHaveBeenCalled()
    expect(storedEnvelopes()).toEqual([calls[1]!.envelope])
  })

  it("keeps one submission per key when StrictMode remounts the hook", async () => {
    const { calls, send } = createDeferredSender()
    const useOperation = createOperationHook({ operation: createRun, send })
    const persistence = sessionStoragePersistence(PERSISTENCE_KEY)
    const strict = renderHook(
      () => useOperation({ scope: PLAYER_1, persistence }),
      {
        wrapper: StrictMode,
      }
    )
    act(() => {
      void strict.result.current.run({ name: "Emerald" })
    })

    const other = mountOperation(useOperation, { persistence })

    expect(other.result.current.status).toBe("sending")
    expect(other.result.current.pending?.args).toEqual({ name: "Emerald" })
    expect(calls).toHaveLength(1)
  })

  it("gives answers to the hook still mounted when a later one with its key unmounts", async () => {
    const { calls, send } = createDeferredSender()
    const useOperation = createOperationHook({ operation: createRun, send })
    const persistence = sessionStoragePersistence(PERSISTENCE_KEY)
    const firstSettled = vi.fn()
    const first = mountOperation(useOperation, {
      persistence,
      onSettled: firstSettled,
    })
    const second = mountOperation(useOperation, { persistence })
    act(() => {
      void first.result.current.run({ name: "Emerald" })
    })

    second.unmount()
    await calls[0]!.answer(ok({ runId: "run-1" }))

    expect(firstSettled).toHaveBeenCalledExactlyOnceWith(ok({ runId: "run-1" }))
  })

  it("delivers an answer that arrived while no hook was mounted on the next mount", async () => {
    const { calls, send } = createDeferredSender()
    const useOperation = createOperationHook({ operation: createRun, send })
    const persistence = sessionStoragePersistence(PERSISTENCE_KEY)
    const first = mountOperation(useOperation, { persistence })
    act(() => {
      void first.result.current.run({ name: "Emerald" })
    })
    first.unmount()
    await calls[0]!.answer(ok({ runId: "run-1" }))

    const onSettled = vi.fn()
    const { result } = mountOperation(useOperation, {
      persistence,
      onSettled,
    })

    expect(onSettled).toHaveBeenCalledExactlyOnceWith(ok({ runId: "run-1" }))
    expect(result.current.status).toBe("settled")
  })
})
