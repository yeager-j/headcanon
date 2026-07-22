// @vitest-environment jsdom

import type { StandardSchemaV1 } from "@standard-schema/spec"
import { act, renderHook, waitFor } from "@testing-library/react"
import { createElement, StrictMode, type ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { err, ok, type Result } from "@workspace/result"

import {
  acceptedStamp,
  axisId,
  defineMutation,
  defineProtocol,
  revisionVector,
  type AcceptedStamp,
  type Canon,
} from "./index"
import {
  createPredictedRoot,
  RetryableDeliveryError,
  useSnapshotRefresh,
  type MutationEnvelope,
  type MutationReceipt,
  type PredictedRootOptions,
} from "./react"

type CounterError = { readonly code: "prediction-refused" }
type CounterArgs = {
  readonly amount: number
  readonly refuseAt?: number
}

const counterArgsSchema: StandardSchemaV1<unknown, CounterArgs> = {
  "~standard": {
    version: 1,
    vendor: "headcanon-test",
    validate(value) {
      return { value: value as CounterArgs }
    },
  },
}

const add = defineMutation({
  name: "counter.add",
  args: counterArgsSchema,
  predict(state: number, args): Result<number, CounterError> {
    if (state === args.refuseAt) {
      return err({ code: "prediction-refused" })
    }
    return ok(state + args.amount)
  },
})

const counterProtocol = defineProtocol({
  id: "test.counter.v1",
  mutations: [add],
})

type CounterInvocation = ReturnType<typeof add>

const counterAxis = axisId("counter/value")
const noRefresh = () => undefined

function useNoRefresh() {
  return useSnapshotRefresh(noRefresh)
}

function vector(revision: number) {
  const parsed = revisionVector({ [counterAxis]: revision })
  if (!parsed.ok) throw new Error("Invalid test revision")
  return parsed.value
}

function canon(value: number, revision: number): Canon<number> {
  return { value, revisions: vector(revision) }
}

function stamp(revision: number): AcceptedStamp {
  return acceptedStamp(vector(revision))
}

interface ControlledDelivery {
  readonly envelope: MutationEnvelope<CounterInvocation>
  resolve(outcome: Result<AcceptedStamp, CounterError>): void
  reject(reason?: unknown): void
}

function createControlledSender() {
  const deliveries: ControlledDelivery[] = []
  const send = vi.fn(
    (envelope: MutationEnvelope<CounterInvocation>) =>
      new Promise<Result<AcceptedStamp, CounterError>>((resolve, reject) => {
        deliveries.push({ envelope, resolve, reject })
      })
  )
  return { deliveries, send }
}

function setup(initialCanon = canon(0, 0)) {
  const controlled = createControlledSender()
  const useCounterPredictions = createPredictedRoot({
    protocol: counterProtocol,
    send: controlled.send,
    refresh: useNoRefresh,
  })
  const rendered = renderHook(
    ({ currentCanon }: { currentCanon: Canon<number> }) =>
      useCounterPredictions({ canon: currentCanon }),
    { initialProps: { currentCanon: initialCanon } }
  )
  return { ...controlled, ...rendered }
}

function mutate(
  root: ReturnType<typeof setup>["result"],
  invocation: CounterInvocation
): MutationReceipt<CounterError> {
  const outcome = root.current.mutate(invocation)
  if (!outcome.ok) throw new Error("Test mutation unexpectedly refused")
  return outcome.value
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("createPredictedRoot", () => {
  it("predicts immediately and accumulates a burst through useOptimistic", () => {
    const { result, send } = setup()

    act(() => {
      mutate(result, add({ amount: 1 }))
      mutate(result, add({ amount: 2 }))
    })

    expect(result.current.value).toBe(3)
    expect(result.current.status.pending).toBe(2)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("locally refuses without allocating an ID or starting delivery", () => {
    const randomUUID = vi.spyOn(globalThis.crypto, "randomUUID")
    const { result, send } = setup()

    let outcome: ReturnType<typeof result.current.mutate> | undefined
    act(() => {
      outcome = result.current.mutate(add({ amount: 1, refuseAt: 0 }))
    })

    expect(outcome).toEqual(err({ code: "prediction-refused" }))
    expect(randomUUID).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(result.current.value).toBe(0)
    expect(result.current.status.pending).toBe(0)
  })

  it("cancels a dependent same-tick refusal during replay", async () => {
    const { result, deliveries, send } = setup()
    let first: MutationReceipt<CounterError>
    let dependent: ReturnType<typeof result.current.mutate> | undefined

    act(() => {
      first = mutate(result, add({ amount: 1 }))
      dependent = result.current.mutate(add({ amount: 2, refuseAt: 1 }))
    })

    expect(dependent?.ok).toBe(true)
    if (!dependent?.ok)
      throw new Error("Dependent mutation was locally refused")
    await expect(dependent.value.accepted).resolves.toEqual(
      err({
        kind: "replay-refused",
        error: { code: "prediction-refused" },
      })
    )
    await expect(dependent.value.canonized).resolves.toEqual(
      err({
        kind: "replay-refused",
        error: { code: "prediction-refused" },
      })
    )
    expect(send).toHaveBeenCalledTimes(1)
    expect(deliveries[0]?.envelope.mutationId).toBe(first!.id)
  })

  it("releases the root queue on rejection and preserves later intent", async () => {
    const { result, deliveries, send } = setup()
    let first: MutationReceipt<CounterError>
    let second: MutationReceipt<CounterError>

    act(() => {
      first = mutate(result, add({ amount: 1 }))
      second = mutate(result, add({ amount: 2 }))
    })
    expect(result.current.value).toBe(3)

    act(() => deliveries[0]?.resolve(err({ code: "prediction-refused" })))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    expect(deliveries[0]?.envelope.invocation.args.amount).toBe(1)
    expect(deliveries[1]?.envelope.invocation.args.amount).toBe(2)

    expect(result.current.value).toBe(2)
    await expect(first!.accepted).resolves.toEqual(
      err({ kind: "domain", error: { code: "prediction-refused" } })
    )
    await expect(first!.canonized).resolves.toEqual(
      err({ kind: "domain", error: { code: "prediction-refused" } })
    )
    expect(result.current.status.pending).toBe(1)

    act(() => deliveries[1]?.resolve(ok(stamp(2))))
    await expect(second!.accepted).resolves.toEqual(ok(stamp(2)))
  })

  it("canonizes A and B independently after their Actions settle at acceptance", async () => {
    // UNN-682: Actions settle at the terminal acceptance, not canonization.
    // The predictions stay rendered because React retains the optimistic
    // updates and the reducer applies an accepted-but-uncovered update over
    // the newer canon; coverage — not Action settlement — reduces each to
    // identity and resolves its `canonized` independently.
    const { result, deliveries, rerender, send } = setup()
    let first: MutationReceipt<CounterError>
    let second: MutationReceipt<CounterError>

    act(() => {
      first = mutate(result, add({ amount: 1 }))
      second = mutate(result, add({ amount: 10 }))
    })
    act(() => deliveries[0]?.resolve(ok(stamp(1))))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    act(() => deliveries[1]?.resolve(ok(stamp(2))))
    await expect(second!.accepted).resolves.toEqual(ok(stamp(2)))

    let firstCanonized = false
    void first!.canonized.then(() => {
      firstCanonized = true
    })
    rerender({ currentCanon: canon(1, 1) })

    expect(result.current.value).toBe(11)
    expect(firstCanonized).toBe(false)
    await expect(first!.canonized).resolves.toEqual(ok(undefined))
    expect(result.current.status.pending).toBe(1)

    rerender({ currentCanon: canon(11, 2) })
    expect(result.current.value).toBe(11)
    await expect(second!.canonized).resolves.toEqual(ok(undefined))
    expect(result.current.status.pending).toBe(0)
  })

  it("reduces a covered accepted update to identity while a sibling keeps it replayed", async () => {
    // The sibling B's open Action keeps A's settled optimistic update in
    // React's replay queue; the acceptedById bookkeeping must reduce A to
    // identity in the very first covering render, so A is never applied on
    // top of a canon that already contains it.
    const predict = vi.fn(
      (state: number, args: CounterArgs): Result<number, CounterError> =>
        ok(state + args.amount)
    )
    const coveredAdd = defineMutation({
      name: "counter.covered-add",
      args: counterArgsSchema,
      predict,
    })
    const protocol = defineProtocol({
      id: "test.coverage.v1",
      mutations: [coveredAdd],
    })
    const deliveries: Array<
      (outcome: Result<AcceptedStamp, CounterError>) => void
    > = []
    const usePredictions = createPredictedRoot({
      protocol,
      send: () =>
        new Promise<Result<AcceptedStamp, CounterError>>((resolve) => {
          deliveries.push(resolve)
        }),
      refresh: useNoRefresh,
    })
    const { result, rerender } = renderHook(
      ({ currentCanon }: { currentCanon: Canon<number> }) =>
        usePredictions({ canon: currentCanon }),
      { initialProps: { currentCanon: canon(0, 0) } }
    )
    let receipt: MutationReceipt<CounterError>

    act(() => {
      const outcome = result.current.mutate(coveredAdd({ amount: 1 }))
      if (!outcome.ok) throw new Error("Coverage mutation was refused")
      receipt = outcome.value
      const sibling = result.current.mutate(coveredAdd({ amount: 10 }))
      if (!sibling.ok) throw new Error("Sibling mutation was refused")
    })
    act(() => deliveries[0]?.(ok(stamp(1))))
    await expect(receipt!.accepted).resolves.toEqual(ok(stamp(1)))
    predict.mockClear()

    let canonized = false
    void receipt!.canonized.then(() => {
      canonized = true
    })
    rerender({ currentCanon: canon(1, 1) })

    // A reduces to identity — its predictor never re-runs — while B replays
    // over the covering canon, applying A's effect exactly once in total.
    expect(predict).not.toHaveBeenCalledWith(expect.anything(), { amount: 1 })
    expect(result.current.value).toBe(11)
    expect(canonized).toBe(false)
    await expect(receipt!.canonized).resolves.toEqual(ok(undefined))
  })

  it("stops double-applying when canon covers before acceptance arrives", async () => {
    const { result, deliveries, rerender } = setup()
    let receipt: MutationReceipt<CounterError>
    act(() => {
      receipt = mutate(result, add({ amount: 1 }))
    })

    const coveringCanon = canon(1, 1)
    rerender({ currentCanon: coveringCanon })
    expect(result.current.value).toBe(2)

    act(() => deliveries[0]?.resolve(ok(stamp(1))))
    await expect(receipt!.accepted).resolves.toEqual(ok(stamp(1)))
    await waitFor(() => expect(result.current.value).toBe(1))
    await expect(receipt!.canonized).resolves.toEqual(ok(undefined))
  })

  it("waits for every coordinate of an accepted vector", async () => {
    const otherAxis = axisId("counter/other")
    const { result, deliveries, rerender } = setup({
      value: 0,
      revisions: vector(0),
    })
    let receipt: MutationReceipt<CounterError>
    act(() => {
      receipt = mutate(result, add({ amount: 1 }))
    })
    const acceptedVector = revisionVector({
      [counterAxis]: 1,
      [otherAxis]: 2,
    })
    if (!acceptedVector.ok) throw new Error("Invalid accepted test vector")

    act(() => deliveries[0]?.resolve(ok(acceptedStamp(acceptedVector.value))))
    await expect(receipt!.accepted).resolves.toEqual(
      ok(acceptedStamp(acceptedVector.value))
    )

    rerender({
      currentCanon: {
        value: 1,
        revisions: vector(1),
      },
    })
    expect(result.current.value).toBe(2)
    expect(result.current.status.pending).toBe(1)

    const covered = revisionVector({ [counterAxis]: 1, [otherAxis]: 2 })
    if (!covered.ok) throw new Error("Invalid covered test vector")
    rerender({ currentCanon: { value: 1, revisions: covered.value } })
    expect(result.current.value).toBe(1)
    await expect(receipt!.canonized).resolves.toEqual(ok(undefined))
  })

  it("cancels a replay-refused envelope that has never been sent", async () => {
    const { result, deliveries, rerender, send } = setup()
    let blocked: MutationReceipt<CounterError>
    let refused: MutationReceipt<CounterError>

    act(() => {
      blocked = mutate(result, add({ amount: 1 }))
      refused = mutate(result, add({ amount: 1, refuseAt: 11 }))
    })
    expect(send).toHaveBeenCalledTimes(1)

    rerender({ currentCanon: canon(10, 10) })

    const replayError = {
      kind: "replay-refused",
      error: { code: "prediction-refused" },
    } as const
    await expect(refused!.accepted).resolves.toEqual(err(replayError))
    await expect(refused!.canonized).resolves.toEqual(err(replayError))
    expect(result.current.value).toBe(11)
    expect(result.current.conflicts).toEqual([
      {
        mutationId: refused!.id,
        invocation: add({ amount: 1, refuseAt: 11 }),
        error: { code: "prediction-refused" },
      },
    ])
    expect(send).toHaveBeenCalledTimes(1)

    act(() => deliveries[0]?.resolve(ok(stamp(11))))
    await expect(blocked!.accepted).resolves.toEqual(ok(stamp(11)))
  })

  it("reconciles replay refusal once under Strict Mode reducer replay", async () => {
    const controlled = createControlledSender()
    const useCounterPredictions = createPredictedRoot({
      protocol: counterProtocol,
      send: controlled.send,
      refresh: useNoRefresh,
    })
    const wrapper = ({ children }: { readonly children: ReactNode }) =>
      createElement(StrictMode, null, children)
    const { result, rerender } = renderHook(
      ({ currentCanon }: { currentCanon: Canon<number> }) =>
        useCounterPredictions({ canon: currentCanon }),
      {
        initialProps: { currentCanon: canon(0, 0) },
        wrapper,
      }
    )
    let refused: MutationReceipt<CounterError>

    act(() => {
      mutate(result, add({ amount: 1 }))
      refused = mutate(result, add({ amount: 1, refuseAt: 11 }))
    })
    rerender({ currentCanon: canon(10, 10) })

    await expect(refused!.accepted).resolves.toEqual(
      err({
        kind: "replay-refused",
        error: { code: "prediction-refused" },
      })
    )
    expect(result.current.conflicts).toHaveLength(1)
    expect(controlled.send).toHaveBeenCalledTimes(1)
  })

  it("isolates delivery and replay from later argument mutation", () => {
    const { result, deliveries, rerender } = setup()
    const args = { amount: 1 }

    act(() => {
      mutate(result, add(args))
    })
    args.amount = 99
    rerender({ currentCanon: canon(10, 10) })

    expect(deliveries[0]?.envelope.invocation.args.amount).toBe(1)
    expect(result.current.value).toBe(11)
  })

  it("does not retract replay-refused sending delivery", async () => {
    const { result, deliveries, rerender, send } = setup()
    let receipt: MutationReceipt<CounterError>
    act(() => {
      receipt = mutate(result, add({ amount: 1, refuseAt: 10 }))
    })
    expect(send).toHaveBeenCalledTimes(1)

    rerender({ currentCanon: canon(10, 10) })
    expect(result.current.value).toBe(10)
    expect(result.current.conflicts).toHaveLength(1)
    expect(send).toHaveBeenCalledTimes(1)

    act(() => deliveries[0]?.resolve(ok(stamp(11))))
    await expect(receipt!.accepted).resolves.toEqual(ok(stamp(11)))
    expect(result.current.status.pending).toBe(1)

    rerender({ currentCanon: canon(11, 11) })
    await expect(receipt!.canonized).resolves.toEqual(ok(undefined))
  })

  it("pauses later intent on uncertain delivery and yields predictions to canon truth", async () => {
    // UNN-682: an unbounded wait for a manual retry may not hold Actions open
    // (a held Action freezes canon delivery and navigation), so the paused
    // queue's predictions revert to canon while the envelopes and receipts
    // stay pending for honest same-ID redelivery.
    const { result, deliveries, send } = setup()
    let first: MutationReceipt<CounterError>

    act(() => {
      first = mutate(result, add({ amount: 1 }))
      mutate(result, add({ amount: 2 }))
    })
    act(() => deliveries[0]?.reject(new Error("response lost")))

    await waitFor(() =>
      expect(result.current.status.delivery).toBe("uncertain")
    )
    await waitFor(() => expect(result.current.value).toBe(0))
    expect(result.current.status.pending).toBe(2)
    expect(send).toHaveBeenCalledTimes(1)

    const marker = vi.fn()
    void first!.accepted.then(marker, marker)
    await Promise.resolve()
    expect(marker).not.toHaveBeenCalled()
  })

  it("retries uncertain delivery with the same envelope and mutation ID", async () => {
    const { result, deliveries, send } = setup()
    let uncertain: MutationReceipt<CounterError>

    act(() => {
      uncertain = mutate(result, add({ amount: 1 }))
      mutate(result, add({ amount: 2 }))
    })
    const originalEnvelope = deliveries[0]?.envelope
    act(() => deliveries[0]?.reject(new Error("response lost")))
    await waitFor(() =>
      expect(result.current.status.delivery).toBe("uncertain")
    )

    act(() => result.current.retryDelivery())
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    expect(deliveries[1]?.envelope).toBe(originalEnvelope)
    expect(deliveries[1]?.envelope.mutationId).toBe(uncertain!.id)

    // The resumed queue re-mounts every paused prediction for the duration
    // of the attempt (same mutation IDs, same replay order).
    await waitFor(() => expect(result.current.value).toBe(3))

    act(() => deliveries[1]?.resolve(ok(stamp(1))))
    await expect(uncertain!.accepted).resolves.toEqual(ok(stamp(1)))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(3))
  })

  it("settles unresolved receipts and releases Actions on unmount", async () => {
    const { result, deliveries, unmount } = setup()
    const unknown = mutate(result, add({ amount: 1 }))
    const queued = mutate(result, add({ amount: 2 }))

    unmount()

    await expect(unknown.accepted).resolves.toEqual(
      err({ kind: "root-unmounted", outcome: "unknown" })
    )
    await expect(unknown.canonized).resolves.toEqual(
      err({ kind: "root-unmounted", outcome: "unknown" })
    )
    await expect(queued.accepted).resolves.toEqual(
      err({ kind: "root-unmounted", outcome: "unknown" })
    )

    act(() => deliveries[0]?.resolve(ok(stamp(1))))
  })

  it("reports known acceptance when an uncovered root unmounts", async () => {
    const { result, deliveries, unmount } = setup()
    let receipt: MutationReceipt<CounterError>
    act(() => {
      receipt = mutate(result, add({ amount: 1 }))
    })
    act(() => deliveries[0]?.resolve(ok(stamp(1))))
    await expect(receipt!.accepted).resolves.toEqual(ok(stamp(1)))

    unmount()

    await expect(receipt!.canonized).resolves.toEqual(
      err({ kind: "root-unmounted", outcome: "accepted" })
    )
  })
})

// ---------------------------------------------------------------------------
// Heterogeneous protocols + mutation-specific refusals (UNN-676/UNN-685)
// ---------------------------------------------------------------------------

type SetArgs = { readonly to: number }

const setArgsSchema: StandardSchemaV1<unknown, SetArgs> = {
  "~standard": {
    version: 1,
    vendor: "headcanon-test",
    validate(value) {
      return { value: value as SetArgs }
    },
  },
}

const counterGoneSchema: StandardSchemaV1<unknown, "counter-gone"> = {
  "~standard": {
    version: 1,
    vendor: "headcanon-test",
    validate(value) {
      return value === "counter-gone"
        ? { value }
        : { issues: [{ message: "Expected counter-gone" }] }
    },
  },
}

const set = defineMutation({
  name: "counter.set",
  args: setArgsSchema,
  refusal: counterGoneSchema,
  predict(state: number, args): Result<number, CounterError> {
    void state
    return ok(args.to)
  },
})

/** Two mutations with DIFFERENT argument schemas plus a mutation-specific
 *  refusal — the shape that used to collapse `StateOf`/`ErrorOf` to `never`
 *  (non-distributive inference over the mutation union). */
const mixedProtocol = defineProtocol({
  id: "test.counter.mixed.v1",
  mutations: [add, set],
})

// Compile-time regression: a send returning the full client error union —
// predictor refusals ∪ mutation-specific receipt refusals — must satisfy the
// options type. With the collapsed-to-`never` bug this assignment fails.
const _mixedSendProbe: PredictedRootOptions<
  typeof mixedProtocol
>["send"] = async () => err<CounterError | "counter-gone">("counter-gone")
void _mixedSendProbe

describe("createPredictedRoot — mutation-specific authority refusals", () => {
  it("rolls back a prediction rejected with the selected mutation's refusal", async () => {
    const deliveries: Array<{
      envelope: MutationEnvelope<
        ReturnType<typeof add> | ReturnType<typeof set>
      >
      resolve: (
        outcome: Result<AcceptedStamp, CounterError | "counter-gone">
      ) => void
    }> = []
    const useMixedPredictions = createPredictedRoot({
      protocol: mixedProtocol,
      send: (envelope) =>
        new Promise((resolve) => {
          deliveries.push({ envelope, resolve })
        }),
      refresh: useNoRefresh,
    })
    const initialCanon = canon(0, 0)
    const { result } = renderHook(() =>
      useMixedPredictions({ canon: initialCanon })
    )

    let receipt!: MutationReceipt<CounterError | "counter-gone">
    act(() => {
      const outcome = result.current.mutate(set({ to: 5 }))
      if (!outcome.ok) throw new Error("unexpected local refusal")
      receipt = outcome.value
    })
    expect(result.current.value).toBe(5)

    await act(async () => deliveries[0]?.resolve(err("counter-gone")))

    await expect(receipt.accepted).resolves.toEqual(
      err({ kind: "domain", error: "counter-gone" })
    )
    expect(result.current.value).toBe(0)
    expect(result.current.status.pending).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Retryable delivery (exhausted authority contention) — UNN-676
// ---------------------------------------------------------------------------

describe("createPredictedRoot — retryable delivery", () => {
  it("redelivers the same envelope on a backoff after a retryable classification", async () => {
    vi.useFakeTimers()
    try {
      const sent: MutationEnvelope<CounterInvocation>[] = []
      let failures = 1
      const send = vi.fn(
        async (envelope: MutationEnvelope<CounterInvocation>) => {
          sent.push(envelope)
          if (failures > 0) {
            failures -= 1
            throw new RetryableDeliveryError("contention")
          }
          return ok(stamp(1))
        }
      )
      const usePredictions = createPredictedRoot({
        protocol: counterProtocol,
        send,
        refresh: useNoRefresh,
      })
      const initialCanon = canon(0, 0)
      const { result } = renderHook(() =>
        usePredictions({ canon: initialCanon })
      )

      let receipt!: MutationReceipt<CounterError>
      act(() => {
        const outcome = result.current.mutate(add({ amount: 1 }))
        if (!outcome.ok) throw new Error("unexpected local refusal")
        receipt = outcome.value
      })
      await act(async () => {})
      expect(send).toHaveBeenCalledTimes(1)

      // The prediction survives and the caller still reads an in-flight send,
      // never a scary uncertain state, while the backoff runs.
      expect(result.current.value).toBe(1)
      expect(result.current.status.delivery).toBe("sending")

      await act(async () => {
        await vi.advanceTimersByTimeAsync(300)
      })

      expect(send).toHaveBeenCalledTimes(2)
      expect(sent[1]!.mutationId).toBe(sent[0]!.mutationId)
      expect(sent[1]!.invocation).toEqual(sent[0]!.invocation)
      await expect(receipt.accepted).resolves.toEqual(ok(stamp(1)))
    } finally {
      vi.useRealTimers()
    }
  })

  it("exhausts the redelivery budget into uncertain; manual retry earns a fresh budget", async () => {
    vi.useFakeTimers()
    try {
      let failures = 4 // initial + the full 300/1000/3000 budget
      const send = vi.fn(
        async (_envelope: MutationEnvelope<CounterInvocation>) => {
          if (failures > 0) {
            failures -= 1
            throw new RetryableDeliveryError("contention")
          }
          return ok(stamp(1))
        }
      )
      const usePredictions = createPredictedRoot({
        protocol: counterProtocol,
        send,
        refresh: useNoRefresh,
      })
      const initialCanon = canon(0, 0)
      const { result } = renderHook(() =>
        usePredictions({ canon: initialCanon })
      )

      act(() => {
        const outcome = result.current.mutate(add({ amount: 1 }))
        if (!outcome.ok) throw new Error("unexpected local refusal")
      })
      await act(async () => {})
      for (const delay of [300, 1000, 3000]) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(delay)
        })
      }

      expect(send).toHaveBeenCalledTimes(4)
      expect(result.current.status.delivery).toBe("uncertain")
      // The envelope is preserved for the honest retry affordance; the
      // prediction yields to canon truth while the queue is paused (UNN-682).
      await act(async () => {})
      expect(result.current.value).toBe(0)
      expect(result.current.status.pending).toBe(1)

      act(() => result.current.retryDelivery())
      await act(async () => {})
      expect(send).toHaveBeenCalledTimes(5)
      expect(result.current.status.delivery).toBe("idle")
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// Farewell delivery of never-sent envelopes on unmount (UNN-676)
// ---------------------------------------------------------------------------

describe("createPredictedRoot — unmount does not discard unsent intent", () => {
  it("sends queued envelopes on the way down, in queue order", async () => {
    // The motivating case: a debounced autosave flushed from a leaf's unmount
    // cleanup. The leaf tears down before the provider, so the mutation is
    // queued into a root that is already unmounting; dropping it silently
    // loses the user's last edit.
    const { result, deliveries, send, unmount } = setup()

    act(() => {
      mutate(result, add({ amount: 1 }))
      mutate(result, add({ amount: 2 }))
    })
    // The head is in flight; the second envelope has never been sent.
    expect(send).toHaveBeenCalledTimes(1)

    unmount()
    await act(async () => {})

    expect(send).toHaveBeenCalledTimes(2)
    expect(deliveries[1]?.envelope.invocation.args.amount).toBe(2)

    act(() => deliveries[0]?.resolve(ok(stamp(1))))
  })

  it("does not re-send an envelope whose delivery may already have committed", async () => {
    const { result, deliveries, send, unmount } = setup()

    act(() => {
      mutate(result, add({ amount: 1 }))
    })
    expect(send).toHaveBeenCalledTimes(1)

    unmount()
    await act(async () => {})

    // The head was `sending`: its receipt, not a second send, decides it.
    expect(send).toHaveBeenCalledTimes(1)

    act(() => deliveries[0]?.resolve(ok(stamp(1))))
  })

  it("still settles a farewell-sent receipt as unmounted-unknown", async () => {
    const { result, deliveries, unmount } = setup()
    let queued!: MutationReceipt<CounterError>
    act(() => {
      mutate(result, add({ amount: 1 }))
      queued = mutate(result, add({ amount: 2 }))
    })

    unmount()
    await act(async () => {})

    // It left, but no mounted root remains to learn the authority's answer.
    await expect(queued.accepted).resolves.toEqual(
      err({ kind: "root-unmounted", outcome: "unknown" })
    )

    act(() => deliveries[0]?.resolve(ok(stamp(1))))
  })
})
