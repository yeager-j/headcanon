// @vitest-environment jsdom

import type { StandardSchemaV1 } from "@standard-schema/spec"
import { act, render, renderHook, waitFor } from "@testing-library/react"
import {
  createElement,
  startTransition,
  StrictMode,
  useEffect,
  useState,
  type ReactNode,
} from "react"
import { err, ok, type Result } from "serializable-result"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  createPredictedRoot,
  createPredictedRootContext,
  DELIVERY_WAIT_MS,
  RetryableDeliveryError,
  sessionStoragePersistence,
  TerminalDeliveryError,
  useSnapshotRefresh,
  type MutationReceipt,
  type MutationStageListeners,
  type PredictedRootOptions,
  type PredictedRootRecoveryListeners,
  type QueuePersistence,
} from "."
import {
  acceptedStamp,
  axisId,
  defineMutation,
  defineProtocol,
  revisionVector,
  type AcceptedStamp,
  type Canon,
  type MutationContext,
  type MutationEnvelope,
} from ".."
import { revisionAt } from "../core/revisions"
import { DELIVERY_RETRY_DELAYS_MS } from "./ledger"
import { createPredictedRootHook } from "./predicted-root"
import { UNCOVERED_REFRESH_RETRY_MS } from "./refresh"

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
      const args = value as Partial<CounterArgs> | null
      if (typeof args?.amount !== "number") {
        return { issues: [{ message: "amount must be a number" }] }
      }
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
  const parsed = acceptedStamp({ revisions: { [counterAxis]: revision } })
  if (!parsed.ok) throw new Error("Invalid test stamp")
  return parsed.value
}

interface ControlledDelivery<
  Invocation = CounterInvocation,
  Error = CounterError,
> {
  readonly envelope: MutationEnvelope<Invocation>
  resolve(outcome: Result<AcceptedStamp, Error>): void
  reject(reason?: unknown): void
}

function createControlledSender<
  Invocation = CounterInvocation,
  Error = CounterError,
>() {
  const deliveries: ControlledDelivery<Invocation, Error>[] = []
  const send = vi.fn(
    (envelope: MutationEnvelope<Invocation>) =>
      new Promise<Result<AcceptedStamp, Error>>((resolve, reject) => {
        deliveries.push({ envelope, resolve, reject })
      })
  )
  return { deliveries, send }
}

function setup(
  initialCanon = canon(0, 0),
  defaultRecoveryListeners?: PredictedRootRecoveryListeners<
    CounterInvocation,
    CounterError
  >,
  mountedRecoveryListeners?: PredictedRootRecoveryListeners<
    CounterInvocation,
    CounterError
  >
) {
  const controlled = createControlledSender()
  const useCounterPredictions = createPredictedRoot({
    protocol: counterProtocol,
    send: controlled.send,
    refresh: useNoRefresh,
    recoveryListeners: defaultRecoveryListeners,
  })
  const rendered = renderHook(
    ({ currentCanon }: { currentCanon: Canon<number> }) =>
      useCounterPredictions({
        canon: currentCanon,
        recoveryListeners: mountedRecoveryListeners,
      }),
    { initialProps: { currentCanon: initialCanon } }
  )
  return { ...controlled, ...rendered }
}

function acceptedLocally<Refusal>(
  outcome: Result<MutationReceipt<Refusal>, Refusal>
): MutationReceipt<Refusal> {
  if (!outcome.ok) throw new Error("Test mutation was locally refused")
  return outcome.value
}

function mutate(
  rootRef: ReturnType<typeof setup>["result"],
  invocation: CounterInvocation,
  listeners?: MutationStageListeners<CounterError>
): MutationReceipt<CounterError> {
  return acceptedLocally(rootRef.current.mutate(invocation, listeners))
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("createPredictedRoot", () => {
  it("predicts immediately and accumulates a burst", () => {
    const { result, send } = setup()

    act(() => {
      mutate(result, add({ amount: 1 }))
      mutate(result, add({ amount: 2 }))
    })

    expect(result.current.value).toBe(3)
    expect(result.current.status.pending).toBe(2)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("observes prediction, acceptance, and canonization as distinct stages", async () => {
    const { result, deliveries, rerender } = setup()
    const stages: string[] = []
    const onPrediction = vi.fn((outcome) => {
      stages.push("prediction")
      expect(outcome.ok).toBe(true)
    })
    const onAcceptance = vi.fn((outcome) => {
      stages.push("acceptance")
      expect(outcome).toEqual(ok(stamp(1)))
    })
    const onCanonization = vi.fn((outcome) => {
      stages.push("canonization")
      expect(outcome).toEqual(ok(undefined))
    })

    let receipt!: MutationReceipt<CounterError>
    act(() => {
      receipt = mutate(result, add({ amount: 1 }), {
        onPrediction,
        onAcceptance,
        onCanonization,
      })
    })

    expect(stages).toEqual(["prediction"])
    act(() => deliveries[0]?.resolve(ok(stamp(1))))
    await receipt.accepted
    expect(stages).toEqual(["prediction", "acceptance"])

    rerender({ currentCanon: canon(1, 1) })
    await receipt.canonized
    expect(stages).toEqual(["prediction", "acceptance", "canonization"])
  })

  it("reports a prediction refusal without opening later stages", () => {
    const { result } = setup()
    const onPrediction = vi.fn()
    const onAcceptance = vi.fn()
    const onCanonization = vi.fn()

    let outcome: ReturnType<typeof result.current.mutate> | undefined
    act(() => {
      outcome = result.current.mutate(add({ amount: 1, refuseAt: 0 }), {
        onPrediction,
        onAcceptance,
        onCanonization,
      })
    })

    expect(outcome).toEqual(err({ code: "prediction-refused" }))
    expect(onPrediction).toHaveBeenCalledWith(
      err({ code: "prediction-refused" })
    )
    expect(onAcceptance).not.toHaveBeenCalled()
    expect(onCanonization).not.toHaveBeenCalled()
  })

  it("reports an authority refusal to acceptance and canonization", async () => {
    const { result, deliveries } = setup()
    const onAcceptance = vi.fn()
    const onCanonization = vi.fn()

    let receipt!: MutationReceipt<CounterError>
    act(() => {
      receipt = mutate(result, add({ amount: 1 }), {
        onAcceptance,
        onCanonization,
      })
    })

    act(() => deliveries[0]?.resolve(err({ code: "prediction-refused" })))
    await receipt.accepted
    await receipt.canonized
    const refusal = err({
      kind: "domain" as const,
      error: { code: "prediction-refused" as const },
    })
    const mutation = { id: receipt.id, restored: false }
    expect(onAcceptance).toHaveBeenCalledWith(refusal, mutation)
    expect(onCanonization).toHaveBeenCalledWith(refusal, mutation)
  })

  it("uses root listeners unless a mutate call overrides that stage", () => {
    const defaultPrediction = vi.fn()
    const overridePrediction = vi.fn()
    const useCounterPredictions = createPredictedRoot({
      protocol: counterProtocol,
      send: createControlledSender().send,
      refresh: useNoRefresh,
      mutationListeners: {
        onPrediction: defaultPrediction,
      },
    })
    const { result } = renderHook(() =>
      useCounterPredictions({ canon: canon(0, 0) })
    )

    act(() => {
      result.current.mutate(add({ amount: 1, refuseAt: 0 }), {
        onPrediction: overridePrediction,
      })
    })

    expect(overridePrediction).toHaveBeenCalledOnce()
    expect(defaultPrediction).not.toHaveBeenCalled()

    act(() => {
      result.current.mutate(add({ amount: 1, refuseAt: 0 }))
    })
    expect(defaultPrediction).toHaveBeenCalledWith(
      err({ code: "prediction-refused" })
    )
  })

  it("locally refuses after allocating an ID without recording or delivering it", () => {
    const randomUUID = vi.spyOn(globalThis.crypto, "randomUUID")
    const { result, send } = setup()

    let outcome: ReturnType<typeof result.current.mutate> | undefined
    act(() => {
      outcome = result.current.mutate(add({ amount: 1, refuseAt: 0 }))
    })

    expect(outcome).toEqual(err({ code: "prediction-refused" }))
    expect(randomUUID).toHaveBeenCalledTimes(1)
    expect(send).not.toHaveBeenCalled()
    expect(result.current.value).toBe(0)
    expect(result.current.status.pending).toBe(0)
  })

  it("shares one immutable envelope identity across initial prediction and replay", () => {
    const contexts: MutationContext[] = []
    const identityAware = defineMutation({
      name: "counter.identity-aware",
      args: counterArgsSchema,
      predict(state: number, args, context) {
        contexts.push(context)
        return ok(state + args.amount)
      },
    })
    const protocol = defineProtocol({
      id: "test.counter.identity.v1",
      mutations: [identityAware],
    })
    const send = vi.fn(
      async (_envelope: MutationEnvelope<ReturnType<typeof identityAware>>) =>
        ok(stamp(1))
    )
    const usePredictions = createPredictedRoot({
      protocol,
      send,
      refresh: useNoRefresh,
    })
    const { result, rerender } = renderHook(
      ({ currentCanon }: { currentCanon: Canon<number> }) =>
        usePredictions({ canon: currentCanon }),
      { initialProps: { currentCanon: canon(0, 0) } }
    )

    let receipt!: MutationReceipt<never>
    act(() => {
      receipt = acceptedLocally(
        result.current.mutate(identityAware({ amount: 1 }))
      )
    })
    rerender({ currentCanon: canon(10, 0) })

    expect(contexts.length).toBeGreaterThanOrEqual(2)
    expect(contexts.every(Object.isFrozen)).toBe(true)
    expect(contexts.map(({ mutationId }) => mutationId)).toEqual(
      contexts.map(() => receipt.id)
    )
    expect(send.mock.calls[0]?.[0].mutationId).toBe(receipt.id)
  })

  it("cancels a dependent same-tick refusal during replay", async () => {
    const { result, deliveries, send } = setup()
    let first: MutationReceipt<CounterError>
    let dependent!: MutationReceipt<CounterError>

    act(() => {
      first = mutate(result, add({ amount: 1 }))
      dependent = mutate(result, add({ amount: 2, refuseAt: 1 }))
    })

    await expect(dependent.accepted).resolves.toEqual(
      err({
        kind: "replay-refused",
        error: { code: "prediction-refused" },
      })
    )
    await expect(dependent.canonized).resolves.toEqual(
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
    // Actions settle at the terminal acceptance, not canonization.
    // The predictions stay rendered because the ledger keeps each accepted
    // stamp and the projection applies an accepted-but-uncovered mutation
    // over the newer canon; coverage — not Action settlement — reduces each
    // to identity and resolves its `canonized` independently.
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
    // A stays in the ledger until coverage is reconciled after the render;
    // the projection must reduce A to identity in the very first covering
    // render, so A is never applied on top of a canon that already contains
    // it.
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
    const { deliveries, send } = createControlledSender<
      ReturnType<typeof coveredAdd>,
      CounterError
    >()
    const usePredictions = createPredictedRoot({
      protocol,
      send,
      refresh: useNoRefresh,
    })
    const { result, rerender } = renderHook(
      ({ currentCanon }: { currentCanon: Canon<number> }) =>
        usePredictions({ canon: currentCanon }),
      { initialProps: { currentCanon: canon(0, 0) } }
    )
    let receipt: MutationReceipt<CounterError>

    act(() => {
      receipt = acceptedLocally(
        result.current.mutate(coveredAdd({ amount: 1 }))
      )
      acceptedLocally(result.current.mutate(coveredAdd({ amount: 10 })))
    })
    act(() => deliveries[0]?.resolve(ok(stamp(1))))
    await expect(receipt!.accepted).resolves.toEqual(ok(stamp(1)))
    predict.mockClear()

    let canonized = false
    void receipt!.canonized.then(() => {
      canonized = true
    })
    rerender({ currentCanon: canon(1, 1) })

    // A reduces to identity — its predictor never re-runs — while B replays
    // over the covering canon, applying A's effect exactly once in total.
    // `predict` takes (state, args, context): the matchers name all three, and
    // the positive control proves they can match at all.
    expect(predict).not.toHaveBeenCalledWith(
      expect.anything(),
      { amount: 1 },
      expect.anything()
    )
    expect(predict).toHaveBeenCalledWith(1, { amount: 10 }, expect.anything())
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
    const accepted = acceptedStamp({
      revisions: { [counterAxis]: 1, [otherAxis]: 2 },
    })
    if (!accepted.ok) throw new Error("Invalid accepted test stamp")

    act(() => deliveries[0]?.resolve(ok(accepted.value)))
    await expect(receipt!.accepted).resolves.toEqual(ok(accepted.value))

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
    const onConflict = vi.fn()
    const { result, deliveries, rerender, send } = setup(canon(0, 0), {
      onConflict,
    })
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
    expect(onConflict).toHaveBeenCalledWith(result.current.conflicts[0])
    rerender({ currentCanon: canon(10, 10) })
    expect(onConflict).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledTimes(1)

    act(() => deliveries[0]?.resolve(ok(stamp(11))))
    await expect(blocked!.accepted).resolves.toEqual(ok(stamp(11)))
  })

  it("reconciles replay refusal once under Strict Mode reducer replay", async () => {
    const { send } = createControlledSender()
    const useCounterPredictions = createPredictedRoot({
      protocol: counterProtocol,
      send,
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
    expect(send).toHaveBeenCalledTimes(1)
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

  it("pauses later intent on uncertain delivery and keeps every prediction rendered", async () => {
    // The wait for a manual retry is unbounded, so no Action stays open (a
    // held Action freezes canon delivery and navigation). Visibility comes
    // from the ledger, not the Action: the paused queue's predictions stay
    // rendered while their envelopes and receipts wait for honest same-ID
    // redelivery.
    const recoveryCleanup = vi.fn()
    const defaultDeliveryListener = vi.fn()
    const onDeliveryUncertain = vi.fn(() => recoveryCleanup)
    const { result, deliveries, send } = setup(
      canon(0, 0),
      { onDeliveryUncertain: defaultDeliveryListener },
      { onDeliveryUncertain }
    )
    let first: MutationReceipt<CounterError>

    act(() => {
      first = mutate(result, add({ amount: 1 }))
      mutate(result, add({ amount: 2 }))
    })
    act(() => deliveries[0]?.reject(new Error("response lost")))

    await waitFor(() =>
      expect(result.current.status.delivery).toBe("uncertain")
    )
    expect(onDeliveryUncertain).toHaveBeenCalledWith({
      retry: result.current.retryDelivery,
    })
    expect(defaultDeliveryListener).not.toHaveBeenCalled()
    await act(async () => {})
    expect(result.current.value).toBe(3)
    expect(result.current.status.pending).toBe(2)
    expect(send).toHaveBeenCalledTimes(1)

    const onSettled = vi.fn()
    void first!.accepted.then(onSettled, onSettled)
    await Promise.resolve()
    expect(onSettled).not.toHaveBeenCalled()

    act(() => result.current.retryDelivery())
    await waitFor(() => expect(recoveryCleanup).toHaveBeenCalledOnce())
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

    // Both predictions stayed rendered through the pause and the retry.
    expect(result.current.value).toBe(3)

    act(() => deliveries[1]?.resolve(ok(stamp(1))))
    await expect(uncertain!.accepted).resolves.toEqual(ok(stamp(1)))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(3))
  })

  it("stamps the envelope's creation time once and resends it on retry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const createdAt = Date.UTC(2026, 0, 1)
    vi.setSystemTime(createdAt)
    const { result, deliveries, send } = setup()

    act(() => {
      mutate(result, add({ amount: 1 }))
    })
    expect(deliveries[0]?.envelope.createdAt).toBe(createdAt)

    vi.setSystemTime(createdAt + 24 * 60 * 60 * 1000)
    act(() => deliveries[0]?.reject(new Error("response lost")))
    await waitFor(() =>
      expect(result.current.status.delivery).toBe("uncertain")
    )
    act(() => result.current.retryDelivery())
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2))

    expect(deliveries[1]?.envelope.createdAt).toBe(createdAt)
    act(() => deliveries[1]?.resolve(ok(stamp(1))))
  })

  it("waits for the server outcome when replay refuses a retried uncertain envelope", async () => {
    // Retry re-queues the envelope, but the lost attempt may have committed:
    // canon that holds the change must not withdraw it as replay-refused.
    const { result, deliveries, rerender, send } = setup()
    let receipt: MutationReceipt<CounterError>
    act(() => {
      receipt = mutate(result, add({ amount: 1, refuseAt: 10 }))
    })
    act(() => deliveries[0]?.reject(new Error("response lost")))
    await waitFor(() =>
      expect(result.current.status.delivery).toBe("uncertain")
    )

    act(() => {
      result.current.retryDelivery()
      rerender({ currentCanon: canon(10, 10) })
    })
    expect(result.current.conflicts).toHaveLength(1)
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    expect(deliveries[1]?.envelope).toBe(deliveries[0]?.envelope)

    act(() => deliveries[1]?.resolve(ok(stamp(10))))
    await expect(receipt!.accepted).resolves.toEqual(ok(stamp(10)))
    await expect(receipt!.canonized).resolves.toEqual(ok(undefined))
  })

  it("settles unresolved receipts and releases Actions on unmount", async () => {
    const { result, deliveries, unmount } = setup()
    const inFlight = mutate(result, add({ amount: 1 }))
    const queued = mutate(result, add({ amount: 2 }))

    unmount()

    await expect(inFlight.accepted).resolves.toEqual(
      err({ kind: "root-unmounted", outcome: "unknown" })
    )
    await expect(inFlight.canonized).resolves.toEqual(
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
// Heterogeneous protocols + mutation-specific refusals
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
  predict(_state: number, args): Result<number, CounterError> {
    return ok(args.to)
  },
})

const mixedProtocol = defineProtocol({
  id: "test.counter.mixed.v1",
  mutations: [add, set],
})

// Compile-time check: for mutations with different argument schemas and a
// mutation-specific refusal, `send` must keep the full error union (predictor
// refusals and receipt refusals). Non-distributive inference over the mutation
// union collapses `StateOf`/`ErrorOf` to `never`, and then this assignment
// fails.
const _mixedSendProbe: PredictedRootOptions<
  typeof mixedProtocol
>["send"] = async () => err<CounterError | "counter-gone">("counter-gone")
void _mixedSendProbe

describe("createPredictedRoot — mutation-specific authority refusals", () => {
  it("rolls back a prediction rejected with the selected mutation's refusal", async () => {
    const { deliveries, send } = createControlledSender<
      ReturnType<typeof add> | ReturnType<typeof set>,
      CounterError | "counter-gone"
    >()
    const useMixedPredictions = createPredictedRoot({
      protocol: mixedProtocol,
      send,
      refresh: useNoRefresh,
    })
    const initialCanon = canon(0, 0)
    const { result } = renderHook(() =>
      useMixedPredictions({ canon: initialCanon })
    )

    let receipt!: MutationReceipt<CounterError | "counter-gone">
    act(() => {
      receipt = acceptedLocally(result.current.mutate(set({ to: 5 })))
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
// Retryable delivery (exhausted authority contention)
// ---------------------------------------------------------------------------

describe("createPredictedRoot — retryable delivery", () => {
  it("redelivers the same envelope on a backoff after a retryable classification", async () => {
    vi.useFakeTimers()
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
    const { result } = renderHook(() => usePredictions({ canon: initialCanon }))

    let receipt!: MutationReceipt<CounterError>
    act(() => {
      receipt = mutate(result, add({ amount: 1 }))
    })
    await act(async () => {})
    expect(send).toHaveBeenCalledTimes(1)

    // The prediction survives and the caller still reads an in-flight send,
    // never a scary uncertain state, while the backoff runs.
    expect(result.current.value).toBe(1)
    expect(result.current.status.delivery).toBe("sending")

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DELIVERY_RETRY_DELAYS_MS[0])
    })

    expect(send).toHaveBeenCalledTimes(2)
    expect(sent[1]!.mutationId).toBe(sent[0]!.mutationId)
    expect(sent[1]!.invocation).toEqual(sent[0]!.invocation)
    await expect(receipt.accepted).resolves.toEqual(ok(stamp(1)))
  })

  it("exhausts the redelivery budget into uncertain; manual retry earns a fresh budget", async () => {
    vi.useFakeTimers()
    let failures = 1 + DELIVERY_RETRY_DELAYS_MS.length
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
    const { result } = renderHook(() => usePredictions({ canon: initialCanon }))

    act(() => {
      mutate(result, add({ amount: 1 }))
    })
    await act(async () => {})
    for (const delay of DELIVERY_RETRY_DELAYS_MS) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delay)
      })
    }

    expect(send).toHaveBeenCalledTimes(1 + DELIVERY_RETRY_DELAYS_MS.length)
    expect(result.current.status.delivery).toBe("uncertain")
    // The envelope is preserved for the honest retry affordance, and the
    // prediction stays rendered while the queue is paused.
    await act(async () => {})
    expect(result.current.value).toBe(1)
    expect(result.current.status.pending).toBe(1)

    act(() => result.current.retryDelivery())
    await act(async () => {})
    expect(send).toHaveBeenCalledTimes(2 + DELIVERY_RETRY_DELAYS_MS.length)
    expect(result.current.status.delivery).toBe("idle")
  })

  it("withdraws a replay-refused retry after only known-clean misses", async () => {
    // Every attempt answered that no receipt exists, so Retry re-queues an
    // envelope that cannot have committed.
    vi.useFakeTimers()
    const send = vi.fn(
      async (_envelope: MutationEnvelope<CounterInvocation>) => {
        throw new RetryableDeliveryError("contention")
      }
    )
    const usePredictions = createPredictedRoot({
      protocol: counterProtocol,
      send,
      refresh: useNoRefresh,
    })
    const { result, rerender } = renderHook(
      ({ currentCanon }: { currentCanon: Canon<number> }) =>
        usePredictions({ canon: currentCanon }),
      { initialProps: { currentCanon: canon(0, 0) } }
    )
    let receipt: MutationReceipt<CounterError>

    act(() => {
      receipt = mutate(result, add({ amount: 1, refuseAt: 10 }))
    })
    await act(async () => {})
    for (const delay of DELIVERY_RETRY_DELAYS_MS) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delay)
      })
    }
    expect(result.current.status.delivery).toBe("uncertain")

    act(() => {
      result.current.retryDelivery()
      rerender({ currentCanon: canon(10, 10) })
    })
    await expect(receipt!.accepted).resolves.toEqual(
      err({ kind: "replay-refused", error: { code: "prediction-refused" } })
    )
    expect(send).toHaveBeenCalledTimes(1 + DELIVERY_RETRY_DELAYS_MS.length)
  })
})

// ---------------------------------------------------------------------------
// Farewell delivery of never-sent envelopes on unmount
// ---------------------------------------------------------------------------

describe("createPredictedRoot — unmount does not discard unsent intent", () => {
  it("sends queued envelopes on the way down, after the in-flight head", async () => {
    // The motivating case: a debounced autosave flushed from a leaf's unmount
    // cleanup. The leaf tears down before the provider, so the mutation is
    // queued into a root that is already unmounting; dropping it silently
    // loses the user's last edit. Two edits to one field must still commit
    // in order, so the farewell waits for the head that is in flight.
    const { result, deliveries, send, unmount } = setup()
    const writes: number[] = []
    // The authority answers the most recently sent request first: the worst
    // case for a farewell that does not wait.
    const answerNewestFirst = async () => {
      for (const delivery of [...deliveries].reverse()) {
        const amount = delivery.envelope.invocation.args.amount
        if (writes.includes(amount)) continue
        writes.push(amount)
        delivery.resolve(ok(stamp(writes.length)))
      }
      await act(async () => {})
    }

    act(() => {
      mutate(result, add({ amount: 1 }))
      mutate(result, add({ amount: 2 }))
    })
    // The head is in flight; the second envelope has never been sent.
    expect(send).toHaveBeenCalledTimes(1)

    unmount()
    await act(async () => {})
    expect(send).toHaveBeenCalledTimes(1)

    await answerNewestFirst()
    expect(send).toHaveBeenCalledTimes(2)
    await answerNewestFirst()

    expect(deliveries[1]?.envelope.invocation.args.amount).toBe(2)
    expect(writes).toEqual([1, 2])
  })

  it("sends a queued envelope on the way down with its original creation time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const headCreatedAt = Date.UTC(2026, 0, 1)
    const queuedCreatedAt = headCreatedAt + 1000
    vi.setSystemTime(headCreatedAt)
    const { result, deliveries, send, unmount } = setup()

    act(() => {
      mutate(result, add({ amount: 1 }))
    })
    vi.setSystemTime(queuedCreatedAt)
    act(() => {
      mutate(result, add({ amount: 2 }))
    })
    vi.setSystemTime(queuedCreatedAt + 60 * 60 * 1000)

    unmount()
    act(() => deliveries[0]?.resolve(ok(stamp(1))))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2))

    expect(deliveries[0]?.envelope.createdAt).toBe(headCreatedAt)
    expect(deliveries[1]?.envelope.createdAt).toBe(queuedCreatedAt)
    act(() => deliveries[1]?.resolve(ok(stamp(2))))
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

// ---------------------------------------------------------------------------
// Prediction lifetime is the ledger's, not the Action's
// ---------------------------------------------------------------------------

describe("createPredictedRoot — prediction lifetime", () => {
  it("keeps an accepted prediction rendered after its Action ends, until canon covers it", async () => {
    // A zero-grace snapshot carrier whose refetch never delivers canon: the
    // Action ends at acceptance and nothing covers the stamp.
    const { result, deliveries, rerender } = setup()
    act(() => {
      mutate(result, add({ amount: 1 }))
    })
    await act(async () => deliveries[0]?.resolve(ok(stamp(1))))
    await act(async () => {})

    expect(result.current.value).toBe(1)
    expect(result.current.status.pending).toBe(1)

    // Later intent predicts from the rendered value, not stale canon.
    act(() => {
      mutate(result, add({ amount: 2 }))
    })
    expect(result.current.value).toBe(3)

    rerender({ currentCanon: canon(1, 1) })
    await act(async () => {})
    expect(result.current.value).toBe(3)
    expect(result.current.status.pending).toBe(1)

    await act(async () => deliveries[1]?.resolve(ok(stamp(2))))
    rerender({ currentCanon: canon(3, 2) })
    await act(async () => {})
    expect(result.current.value).toBe(3)
    expect(result.current.status.pending).toBe(0)
  })

  it("requires an accepted stamp in every render that holds the acceptance", async () => {
    const { deliveries, send } = createControlledSender()
    const usePredictions = createPredictedRoot({
      protocol: counterProtocol,
      send,
      refresh: useNoRefresh,
    })
    const renders: {
      readonly status: ReturnType<typeof usePredictions>["status"]
      readonly revision: number | undefined
    }[] = []
    const { result, rerender } = renderHook(
      ({ currentCanon }: { currentCanon: Canon<number> }) => {
        const root = usePredictions({ canon: currentCanon })
        renders.push({
          status: root.status,
          revision: revisionAt(currentCanon.revisions, counterAxis),
        })
        return root
      },
      { initialProps: { currentCanon: canon(0, 0) } }
    )

    act(() => {
      mutate(result, add({ amount: 1 }))
    })
    await act(async () => deliveries[0]?.resolve(ok(stamp(1))))
    await act(async () => {})
    rerender({ currentCanon: canon(1, 1) })
    await act(async () => {})

    // With one mutation, `idle` and pending means it is accepted. Its stamp
    // is uncovered while canon is behind revision 1.
    const uncovered = renders.filter(
      ({ status, revision }) =>
        status.delivery === "idle" && status.pending > 0 && (revision ?? 0) < 1
    )
    expect(uncovered.length).toBeGreaterThan(0)
    for (const { status } of uncovered) {
      expect(status.freshness).not.toBe("current")
    }
    for (const { status } of renders.filter(({ status }) => !status.pending)) {
      expect(status.freshness).toBe("current")
    }
    expect(result.current.status).toMatchObject({
      pending: 0,
      freshness: "current",
    })
  })

  it("keeps an accepted prediction rendered while the refresh carrier stalls", async () => {
    vi.useFakeTimers()
    const { deliveries, send } = createControlledSender()
    const refetch = vi.fn(async () => undefined)
    const useResolvingRefresh = () => useSnapshotRefresh(refetch)
    const usePredictions = createPredictedRoot({
      protocol: counterProtocol,
      send,
      refresh: useResolvingRefresh,
    })
    const initialCanon = canon(0, 0)
    const { result } = renderHook(() => usePredictions({ canon: initialCanon }))

    act(() => {
      mutate(result, add({ amount: 1 }))
    })
    await act(async () => deliveries[0]?.resolve(ok(stamp(1))))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNCOVERED_REFRESH_RETRY_MS)
    })

    expect(refetch).toHaveBeenCalledTimes(2)
    expect(result.current.status.freshness).toBe("stalled")
    expect(result.current.value).toBe(1)
    expect(result.current.status.pending).toBe(1)
  })

  it("releases a stalled sender's Action into uncertain delivery after the bounded wait", async () => {
    vi.useFakeTimers()
    const { deliveries, send } = createControlledSender()
    const usePredictions = createPredictedRoot({
      protocol: counterProtocol,
      send,
      refresh: useNoRefresh,
    })
    const initialCanon = canon(0, 0)
    const { result } = renderHook(() => {
      const root = usePredictions({ canon: initialCanon })
      const [unrelated, setUnrelated] = useState(0)
      return { root, unrelated, setUnrelated }
    })

    let receipt!: MutationReceipt<CounterError>
    act(() => {
      receipt = acceptedLocally(result.current.root.mutate(add({ amount: 1 })))
    })
    await act(async () => {
      startTransition(() => result.current.setUnrelated(1))
    })
    // React entangles transitions with the open delivery Action.
    expect(result.current.unrelated).toBe(0)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DELIVERY_WAIT_MS)
    })
    await act(async () => {})

    expect(result.current.root.status.delivery).toBe("uncertain")
    expect(result.current.unrelated).toBe(1)
    expect(result.current.root.value).toBe(1)
    expect(result.current.root.status.pending).toBe(1)

    // Exact-envelope retry while the first request is still unanswered.
    act(() => result.current.root.retryDelivery())
    expect(send).toHaveBeenCalledTimes(2)
    expect(deliveries[1]?.envelope).toBe(deliveries[0]?.envelope)

    // The late answer to the first request is still the authority's answer
    // for this mutation ID.
    await act(async () => deliveries[0]?.resolve(ok(stamp(1))))
    await expect(receipt.accepted).resolves.toEqual(ok(stamp(1)))
    expect(result.current.root.status.delivery).toBe("idle")

    // The retry's answer is the same receipt and changes nothing.
    await act(async () => deliveries[1]?.resolve(ok(stamp(1))))
    expect(result.current.root.value).toBe(1)
    expect(result.current.root.status.pending).toBe(1)
  })

  it("ignores a superseded attempt's late failure while the retry is in flight", async () => {
    vi.useFakeTimers()
    const { result, deliveries } = setup()
    let receipt!: MutationReceipt<CounterError>
    act(() => {
      receipt = mutate(result, add({ amount: 1 }))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DELIVERY_WAIT_MS)
    })
    expect(result.current.status.delivery).toBe("uncertain")

    act(() => result.current.retryDelivery())
    await act(async () => deliveries[0]?.reject(new Error("late failure")))
    expect(result.current.status.delivery).toBe("sending")

    await act(async () => deliveries[1]?.resolve(ok(stamp(1))))
    await expect(receipt.accepted).resolves.toEqual(ok(stamp(1)))
  })
})

// ---------------------------------------------------------------------------
// Terminal delivery failures, uncertain heads, and control flow
// ---------------------------------------------------------------------------

describe("createPredictedRoot — terminal and paused delivery", () => {
  it("settles a terminal delivery failure without retrying and releases the queue", async () => {
    const { result, deliveries, send } = setup()
    let refused!: MutationReceipt<CounterError>
    let next!: MutationReceipt<CounterError>
    act(() => {
      refused = mutate(result, add({ amount: 1 }))
      next = mutate(result, add({ amount: 2 }))
    })

    const failure = {
      kind: "undeliverable",
      error: { code: "invalid-envelope", reason: "invalid-protocol" },
    } as const
    await act(async () =>
      deliveries[0]?.reject(new TerminalDeliveryError(failure))
    )

    await expect(refused.accepted).resolves.toEqual(err(failure))
    await expect(refused.canonized).resolves.toEqual(err(failure))
    expect(result.current.status.delivery).toBe("sending")
    expect(result.current.value).toBe(2)
    expect(send).toHaveBeenCalledTimes(2)
    expect(deliveries[1]?.envelope.mutationId).toBe(next.id)
  })

  it("reports a stale-client failure to both stage listeners", async () => {
    const { result, deliveries } = setup()
    const onAcceptance = vi.fn()
    const onCanonization = vi.fn()
    let receipt!: MutationReceipt<CounterError>
    act(() => {
      receipt = mutate(result, add({ amount: 1 }), {
        onAcceptance,
        onCanonization,
      })
    })

    const cause = new Error("the server does not know this action")
    await act(async () =>
      deliveries[0]?.reject(
        new TerminalDeliveryError({ kind: "stale-client" }, { cause })
      )
    )

    const staleClient = err({ kind: "stale-client" })
    const mutation = { id: receipt.id, restored: false }
    expect(onAcceptance).toHaveBeenCalledExactlyOnceWith(staleClient, mutation)
    expect(onCanonization).toHaveBeenCalledExactlyOnceWith(
      staleClient,
      mutation
    )
    expect(result.current.value).toBe(0)
    expect(result.current.status.delivery).toBe("idle")
  })

  it("queues intent recorded while the head is uncertain behind that head", async () => {
    const { result, deliveries, send } = setup()
    act(() => {
      mutate(result, add({ amount: 1 }))
    })
    await act(async () => deliveries[0]?.reject(new Error("response lost")))
    expect(result.current.status.delivery).toBe("uncertain")

    let later!: MutationReceipt<CounterError>
    act(() => {
      later = mutate(result, add({ amount: 2 }))
    })
    expect(result.current.value).toBe(3)
    expect(result.current.status.delivery).toBe("uncertain")
    expect(send).toHaveBeenCalledTimes(1)

    act(() => result.current.retryDelivery())
    await act(async () => deliveries[1]?.resolve(ok(stamp(1))))
    expect(send).toHaveBeenCalledTimes(3)
    expect(deliveries[2]?.envelope.mutationId).toBe(later.id)
  })

  it("lets a mounted conflict listener override the factory default", async () => {
    const defaultConflict = vi.fn()
    const mountedConflict = vi.fn()
    const { result, rerender } = setup(
      canon(0, 0),
      { onConflict: defaultConflict },
      { onConflict: mountedConflict }
    )
    act(() => {
      mutate(result, add({ amount: 1 }))
      mutate(result, add({ amount: 1, refuseAt: 11 }))
    })
    rerender({ currentCanon: canon(10, 10) })
    await act(async () => {})

    expect(mountedConflict).toHaveBeenCalledOnce()
    expect(defaultConflict).not.toHaveBeenCalled()
  })

  it("cancels a mutation and propagates a classified control-flow throw", async () => {
    const signal = new Error("framework control flow")
    const propagated = vi.fn()
    const captureSignal = (event: ErrorEvent) => {
      if (event.error !== signal) return
      event.preventDefault()
      propagated(event.error)
    }
    window.addEventListener("error", captureSignal)
    try {
      const { deliveries, send } = createControlledSender()
      const usePredictions = createPredictedRootHook(
        {
          protocol: counterProtocol,
          send,
          refresh: useNoRefresh,
        },
        (error) => {
          if (error === signal) throw error
        }
      )
      const initialCanon = canon(0, 0)
      const { result } = renderHook(() =>
        usePredictions({ canon: initialCanon })
      )
      let receipt!: MutationReceipt<CounterError>
      act(() => {
        receipt = mutate(result, add({ amount: 1 }))
      })
      await act(async () => deliveries[0]?.reject(signal))

      const cancelled = err({ kind: "delivery-cancelled" } as const)
      await expect(receipt.accepted).resolves.toEqual(cancelled)
      await expect(receipt.canonized).resolves.toEqual(cancelled)
      await waitFor(() => expect(propagated).toHaveBeenCalledWith(signal))
      expect(result.current.value).toBe(0)
      expect(result.current.status.pending).toBe(0)
    } finally {
      window.removeEventListener("error", captureSignal)
    }
  })
})

// ---------------------------------------------------------------------------
// A persisted queue survives a page load
// ---------------------------------------------------------------------------

/** A persistence adapter whose stored value goes through JSON, like Web Storage. */
function createMemoryPersistence(initial?: unknown) {
  let stored: unknown = initial
  const persistence: QueuePersistence = {
    load: () => stored,
    save(envelopes) {
      stored =
        envelopes.length === 0
          ? undefined
          : (JSON.parse(JSON.stringify(envelopes)) as unknown)
    },
  }

  return { persistence, stored: () => stored }
}

interface MountPersistedOptions {
  readonly canon?: Canon<number>
  readonly strict?: boolean
  readonly mutationListeners?: MutationStageListeners<CounterError>
}

/** Mounts a root as a fresh page would: a new hook, sender, and ledger. */
function mountPersisted(
  persistence: PredictedRootOptions<typeof counterProtocol>["persistence"],
  {
    canon: initialCanon = canon(0, 0),
    strict,
    mutationListeners,
  }: MountPersistedOptions = {}
) {
  const controlled = createControlledSender()
  const useCounterPredictions = createPredictedRoot({
    protocol: counterProtocol,
    send: controlled.send,
    refresh: useNoRefresh,
    persistence,
    mutationListeners,
  })
  const wrapper = strict
    ? ({ children }: { readonly children: ReactNode }) =>
        createElement(StrictMode, null, children)
    : undefined
  const rendered = renderHook(
    ({ currentCanon }: { currentCanon: Canon<number> }) =>
      useCounterPredictions({ canon: currentCanon }),
    { initialProps: { currentCanon: initialCanon }, wrapper }
  )

  return { ...controlled, ...rendered }
}

function storedEnvelope(
  args: CounterArgs,
  createdAt = Date.UTC(2026, 0, 1)
): MutationEnvelope<CounterInvocation> {
  return {
    protocol: counterProtocol.id,
    mutationId: globalThis.crypto.randomUUID(),
    createdAt,
    invocation: { name: add.name, args } as CounterInvocation,
  }
}

function mutationIds(stored: unknown): string[] {
  return (stored as MutationEnvelope<unknown>[]).map(
    (envelope) => envelope.mutationId
  )
}

describe("createPredictedRoot — persisted queue", () => {
  afterEach(() => {
    globalThis.sessionStorage.clear()
  })

  it("stores each queued mutation and removes it when it settles", async () => {
    const { persistence, stored } = createMemoryPersistence()
    const { result, deliveries } = mountPersisted(persistence)
    let first!: MutationReceipt<CounterError>
    let second!: MutationReceipt<CounterError>

    act(() => {
      first = mutate(result, add({ amount: 1 }))
      second = mutate(result, add({ amount: 2 }))
    })
    expect(stored()).toEqual([deliveries[0]?.envelope, expect.anything()])
    expect(mutationIds(stored())).toEqual([first.id, second.id])

    act(() => deliveries[0]?.resolve(ok(stamp(1))))
    await expect(first.accepted).resolves.toEqual(ok(stamp(1)))
    expect(mutationIds(stored())).toEqual([second.id])

    await waitFor(() => expect(deliveries).toHaveLength(2))
    await act(async () =>
      deliveries[1]?.reject(new TerminalDeliveryError({ kind: "denied" }))
    )
    await expect(second.accepted).resolves.toEqual(err({ kind: "denied" }))
    expect(stored()).toBeUndefined()
  })

  it("keeps the stored queue when the root unmounts", async () => {
    const { persistence, stored } = createMemoryPersistence()
    const { result, deliveries, unmount } = mountPersisted(persistence)
    let first!: MutationReceipt<CounterError>
    let second!: MutationReceipt<CounterError>
    act(() => {
      first = mutate(result, add({ amount: 1 }))
      second = mutate(result, add({ amount: 2 }))
    })

    unmount()
    await expect(first.accepted).resolves.toEqual(
      err({ kind: "root-unmounted", outcome: "unknown" })
    )

    expect(mutationIds(stored())).toEqual([first.id, second.id])
    act(() => deliveries[0]?.resolve(ok(stamp(1))))
  })

  it("redelivers the stored queue in order after a reload, before new mutations", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const firstCreatedAt = Date.UTC(2026, 0, 1)
    vi.setSystemTime(firstCreatedAt)
    const { persistence } = createMemoryPersistence()
    const firstPage = mountPersisted(persistence)
    let first!: MutationReceipt<CounterError>
    let second!: MutationReceipt<CounterError>
    act(() => {
      first = mutate(firstPage.result, add({ amount: 1 }))
    })
    vi.setSystemTime(firstCreatedAt + 1000)
    act(() => {
      second = mutate(firstPage.result, add({ amount: 2 }))
    })
    // A full-page load: nothing in memory survives, and nothing settles.
    firstPage.unmount()
    vi.setSystemTime(firstCreatedAt + 60_000)

    const { result, deliveries } = mountPersisted(persistence)
    act(() => {
      mutate(result, add({ amount: 3 }))
    })

    expect(result.current.value).toBe(6)
    expect(result.current.status.pending).toBe(3)
    expect(result.current.status.delivery).toBe("sending")
    expect(deliveries[0]?.envelope).toEqual(firstPage.deliveries[0]?.envelope)
    expect(deliveries[0]?.envelope).toMatchObject({
      mutationId: first.id,
      createdAt: firstCreatedAt,
    })

    act(() => deliveries[0]?.resolve(ok(stamp(1))))
    await waitFor(() => expect(deliveries).toHaveLength(2))
    expect(deliveries[1]?.envelope).toMatchObject({
      mutationId: second.id,
      createdAt: firstCreatedAt + 1000,
    })
    act(() => deliveries[1]?.resolve(ok(stamp(2))))
    await waitFor(() => expect(deliveries).toHaveLength(3))
    expect(deliveries[2]?.envelope.invocation.args.amount).toBe(3)
    act(() => deliveries[2]?.resolve(ok(stamp(3))))
    act(() => firstPage.deliveries[0]?.resolve(ok(stamp(1))))
  })

  it("restores before a mutate from a child's mount effect, and predicts over it", async () => {
    // The child's effect runs before the root's. Its mutation refuses at 0,
    // so it succeeds only when predicted over the restored one.
    const restored = storedEnvelope({ amount: 1 })
    const { persistence, stored } = createMemoryPersistence([restored])
    const { send } = createControlledSender()
    const useCounterPredictions = createPredictedRoot({
      protocol: counterProtocol,
      send,
      refresh: useNoRefresh,
      persistence,
    })
    const CounterRoot = createPredictedRootContext(useCounterPredictions, {
      name: "CounterRoot",
    })
    let outcome: Result<MutationReceipt<CounterError>, CounterError> | null =
      null
    let storedOnReturn: string[] = []
    function MutateOnMount() {
      const { mutate: mutateRoot, value } = CounterRoot.useRoot()
      useEffect(() => {
        if (outcome) return
        outcome = mutateRoot(add({ amount: 2, refuseAt: 0 }))
        storedOnReturn = mutationIds(stored())
      }, [mutateRoot])
      return createElement("output", null, value)
    }

    const view = render(
      createElement(CounterRoot.Provider, {
        canon: canon(0, 0),
        children: createElement(MutateOnMount),
      })
    )

    const receipt = acceptedLocally(outcome!)
    expect(storedOnReturn).toEqual([restored.mutationId, receipt.id])
    await waitFor(() => expect(send).toHaveBeenCalled())
    expect(send.mock.calls[0]?.[0].mutationId).toBe(restored.mutationId)
    expect(mutationIds(stored())).toEqual([restored.mutationId, receipt.id])
    expect(view.container.textContent).toBe("3")
  })

  it("gives each root the store its first canon selects", () => {
    // One factory mounts a root per record; each record has its own queue.
    const stores = new Map<number, ReturnType<typeof createMemoryPersistence>>()
    const selectStore = vi.fn((first: Canon<number>) => {
      const memory = stores.get(first.value) ?? createMemoryPersistence()
      stores.set(first.value, memory)
      return memory.persistence
    })
    const recordA = mountPersisted(selectStore, { canon: canon(0, 0) })
    let receipt!: MutationReceipt<CounterError>
    act(() => {
      receipt = mutate(recordA.result, add({ amount: 1 }))
    })
    recordA.rerender({ currentCanon: canon(5, 1) })

    const recordB = mountPersisted(selectStore, { canon: canon(100, 0) })

    expect(selectStore).toHaveBeenCalledTimes(2)
    expect(mutationIds(stores.get(0)?.stored())).toEqual([receipt.id])
    expect(stores.get(100)?.stored()).toBeUndefined()
    expect(recordB.result.current.value).toBe(100)
    expect(recordB.result.current.status.pending).toBe(0)
    expect(recordB.send).not.toHaveBeenCalled()
    act(() => recordA.deliveries[0]?.resolve(ok(stamp(1))))
  })

  it("keeps a late outcome of a replaced root out of its replacement's store", async () => {
    // Root B replaces root A in one commit. A's answer arrives after A
    // deactivated but before its deferred disposal; it must not write A's
    // queue over the one B restored.
    const { persistence, stored } = createMemoryPersistence()
    const { deliveries, send } = createControlledSender()
    const useCounterPredictions = createPredictedRoot({
      protocol: counterProtocol,
      send,
      refresh: useNoRefresh,
      persistence,
    })
    const roots = new Map<string, ReturnType<typeof useCounterPredictions>>()
    function CounterView({ name }: { readonly name: string }) {
      roots.set(name, useCounterPredictions({ canon: canon(0, 0) }))
      return null
    }
    const view = render(createElement(CounterView, { key: "a", name: "a" }))
    let receipt!: MutationReceipt<CounterError>
    act(() => {
      receipt = acceptedLocally(roots.get("a")!.mutate(add({ amount: 1 })))
    })

    act(() => {
      deliveries[0]?.resolve(ok(stamp(1)))
      view.rerender(createElement(CounterView, { key: "b", name: "b" }))
    })
    await act(async () => {})

    expect(roots.get("b")?.status.pending).toBe(1)
    expect(mutationIds(stored())).toEqual([receipt.id])
  })

  it("replays a restored prediction over the new page's canon", () => {
    const { persistence } = createMemoryPersistence([
      storedEnvelope({ amount: 1 }),
    ])

    const { result } = mountPersisted(persistence, { canon: canon(10, 10) })

    expect(result.current.value).toBe(11)
  })

  it("delivers a restored mutation that replay refuses instead of withdrawing it", async () => {
    // The earlier page may have sent it, so the write may already exist. It
    // waits behind the head, where a never-sent mutation would be withdrawn.
    const head = storedEnvelope({ amount: 1 })
    const refused = storedEnvelope({ amount: 1, refuseAt: 11 })
    const { persistence, stored } = createMemoryPersistence([head, refused])
    const onAcceptance = vi.fn()

    const { result, deliveries } = mountPersisted(persistence, {
      canon: canon(10, 10),
      mutationListeners: { onAcceptance },
    })

    expect(result.current.value).toBe(11)
    expect(result.current.conflicts).toEqual([
      expect.objectContaining({ mutationId: refused.mutationId }),
    ])
    expect(result.current.status.pending).toBe(2)
    expect(mutationIds(stored())).toEqual([head.mutationId, refused.mutationId])

    act(() => deliveries[0]?.resolve(ok(stamp(11))))
    await waitFor(() => expect(deliveries).toHaveLength(2))
    expect(deliveries[1]?.envelope.mutationId).toBe(refused.mutationId)

    act(() => deliveries[1]?.resolve(ok(stamp(12))))
    await waitFor(() =>
      expect(onAcceptance).toHaveBeenCalledWith(ok(stamp(12)), {
        id: refused.mutationId,
        restored: true,
      })
    )
  })

  it("reports restored outcomes to the factory's listeners", async () => {
    const restored = storedEnvelope({ amount: 1 })
    const { persistence } = createMemoryPersistence([restored])
    const onPrediction = vi.fn()
    const onAcceptance = vi.fn()
    const onCanonization = vi.fn()
    const { deliveries, rerender } = mountPersisted(persistence, {
      mutationListeners: { onPrediction, onAcceptance, onCanonization },
    })
    const mutation = { id: restored.mutationId, restored: true }

    act(() => deliveries[0]?.resolve(ok(stamp(1))))
    await waitFor(() =>
      expect(onAcceptance).toHaveBeenCalledExactlyOnceWith(
        ok(stamp(1)),
        mutation
      )
    )
    rerender({ currentCanon: canon(1, 1) })
    await waitFor(() =>
      expect(onCanonization).toHaveBeenCalledExactlyOnceWith(
        ok(undefined),
        mutation
      )
    )
    expect(onPrediction).not.toHaveBeenCalled()
  })

  it("delivers a restored mutation once under Strict Mode", async () => {
    const restored = storedEnvelope({ amount: 1 })
    const { persistence } = createMemoryPersistence([restored])

    const { result, send } = mountPersisted(persistence, { strict: true })
    await act(async () => {})

    expect(send).toHaveBeenCalledExactlyOnceWith(restored)
    expect(result.current.value).toBe(1)
    expect(result.current.status.pending).toBe(1)
  })

  it("drops stored entries the root cannot deliver and keeps the rest", () => {
    const valid = storedEnvelope({ amount: 1 })
    const invalid = [
      { ...storedEnvelope({ amount: 2 }), protocol: "test.other.v1" },
      {
        ...storedEnvelope({ amount: 3 }),
        invocation: { name: "counter.remove", args: { amount: 3 } },
      },
      (({ createdAt: _createdAt, ...rest }) => rest)(
        storedEnvelope({ amount: 4 })
      ),
      { ...storedEnvelope({ amount: 5 }), mutationId: "not-a-uuid" },
      {
        ...storedEnvelope({ amount: 6 }),
        invocation: { name: add.name, args: { amount: "6" } },
      },
      { ...valid, invocation: { name: add.name, args: { amount: 7 } } },
      "not an envelope",
    ]
    const { persistence, stored } = createMemoryPersistence([valid, ...invalid])

    const { result } = mountPersisted(persistence)

    expect(result.current.value).toBe(1)
    expect(result.current.status.pending).toBe(1)
    expect(stored()).toEqual([valid])
  })

  it("drops stored arguments that a coercing or defaulting schema changes", () => {
    // Authority admits only parsed-form arguments; the predictor must not run
    // on a value its schema never produced.
    const coercingArgsSchema: StandardSchemaV1<unknown, CounterArgs> = {
      "~standard": {
        version: 1,
        vendor: "headcanon-test",
        validate(value) {
          const amount = (value as { readonly amount?: unknown }).amount
          if (amount === undefined) return { value: { amount: 1 } }
          return { value: { amount: Number(amount) } }
        },
      },
    }
    const addCoerced = defineMutation({
      name: "counter.add-coerced",
      args: coercingArgsSchema,
      predict: (state: number, args): Result<number, CounterError> =>
        ok(state + args.amount),
    })
    const coercingProtocol = defineProtocol({
      id: "test.coercing.v1",
      mutations: [addCoerced],
    })
    const envelopeFor = (args: unknown) => ({
      protocol: coercingProtocol.id,
      mutationId: globalThis.crypto.randomUUID(),
      createdAt: Date.UTC(2026, 0, 1),
      invocation: { name: addCoerced.name, args },
    })
    const valid = envelopeFor({ amount: 2 })
    const { persistence, stored } = createMemoryPersistence([
      envelopeFor({ amount: "5" }),
      envelopeFor({}),
      valid,
    ])
    const useCoercedPredictions = createPredictedRoot({
      protocol: coercingProtocol,
      send: createControlledSender<ReturnType<typeof addCoerced>>().send,
      refresh: useNoRefresh,
      persistence,
    })

    const { result } = renderHook(() =>
      useCoercedPredictions({ canon: canon(0, 0) })
    )

    expect(result.current.value).toBe(2)
    expect(result.current.status.pending).toBe(1)
    expect(stored()).toEqual([valid])
  })

  it("restores nothing from a stored value that is not a list", () => {
    const { persistence, stored } = createMemoryPersistence({ queue: [] })

    const { result } = mountPersisted(persistence)

    expect(result.current.status.pending).toBe(0)
    expect(stored()).toBeUndefined()
  })

  it("keeps working in memory when the store throws", async () => {
    const persistence: QueuePersistence = {
      load() {
        throw new DOMException("blocked", "SecurityError")
      },
      save() {
        throw new DOMException("full", "QuotaExceededError")
      },
    }
    const { result, deliveries } = mountPersisted(persistence)
    let receipt!: MutationReceipt<CounterError>

    act(() => {
      receipt = mutate(result, add({ amount: 1 }))
    })
    expect(result.current.value).toBe(1)

    act(() => deliveries[0]?.resolve(ok(stamp(1))))
    await expect(receipt.accepted).resolves.toEqual(ok(stamp(1)))
  })
})

describe("sessionStoragePersistence", () => {
  afterEach(() => {
    globalThis.sessionStorage.clear()
  })

  it("stores the queue as JSON under its key and removes the key when it empties", async () => {
    const persistence = sessionStoragePersistence("counter-queue")
    const { result, deliveries } = mountPersisted(persistence)
    let receipt!: MutationReceipt<CounterError>

    act(() => {
      receipt = mutate(result, add({ amount: 1 }))
    })
    const stored = globalThis.sessionStorage.getItem("counter-queue")
    expect(JSON.parse(stored ?? "null")).toEqual([deliveries[0]?.envelope])
    expect(persistence.load()).toEqual([deliveries[0]?.envelope])

    act(() => deliveries[0]?.resolve(ok(stamp(1))))
    await expect(receipt.accepted).resolves.toEqual(ok(stamp(1)))
    expect(globalThis.sessionStorage.getItem("counter-queue")).toBeNull()
  })

  it("replaces a stored value that is not JSON", () => {
    globalThis.sessionStorage.setItem("counter-queue", "{not json")
    const persistence = sessionStoragePersistence("counter-queue")

    const { result } = mountPersisted(persistence)
    act(() => {
      mutate(result, add({ amount: 1 }))
    })

    expect(result.current.value).toBe(1)
    expect(persistence.load()).toHaveLength(1)
  })

  it("does not break mutate when sessionStorage refuses a write", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError")
    })
    const { result, send } = mountPersisted(
      sessionStoragePersistence("counter-queue")
    )

    act(() => {
      mutate(result, add({ amount: 1 }))
    })

    expect(result.current.value).toBe(1)
    expect(send).toHaveBeenCalledOnce()
  })
})
