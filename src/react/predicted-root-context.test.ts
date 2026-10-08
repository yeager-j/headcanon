// @vitest-environment jsdom

import type { StandardSchemaV1 } from "@standard-schema/spec"
import { act, renderHook, waitFor } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { ok, type Result } from "serializable-result"
import { describe, expect, it, vi } from "vitest"

import {
  createPredictedRoot,
  createPredictedRootContext,
  useSnapshotRefresh,
  type MutationReceipt,
} from "."
import {
  axisId,
  defineMutation,
  defineProtocol,
  type AcceptedStamp,
  type Canon,
  type MutationEnvelope,
} from ".."
import { revisionVector } from "../core/revisions"

type CounterError = { readonly code: "prediction-refused" }
type CounterArgs = { readonly amount: number }

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

const initialRevisions = revisionVector({ [counterAxis]: 0 })
if (!initialRevisions.ok) throw new Error("Invalid test revision")
const initialCanon: Canon<number> = {
  value: 0,
  revisions: initialRevisions.value,
}

interface ControlledDelivery {
  reject(reason?: unknown): void
}

function createControlledSender() {
  const deliveries: ControlledDelivery[] = []
  const send = vi.fn(
    (_envelope: MutationEnvelope<CounterInvocation>) =>
      new Promise<Result<AcceptedStamp, CounterError>>((_resolve, reject) => {
        deliveries.push({ reject })
      })
  )
  return { deliveries, send }
}

function acceptedLocally<Refusal>(
  outcome: Result<MutationReceipt<Refusal>, Refusal>
): MutationReceipt<Refusal> {
  if (!outcome.ok) throw new Error("Test mutation was locally refused")
  return outcome.value
}

describe("createPredictedRootContext", () => {
  it("mounts one root and its recovery listeners for every consumer", async () => {
    const { deliveries, send } = createControlledSender()
    const onDeliveryUncertain = vi.fn()
    const useCounterPredictions = createPredictedRoot({
      protocol: counterProtocol,
      send,
      refresh: useNoRefresh,
    })
    const CounterRoot = createPredictedRootContext(useCounterPredictions, {
      name: "CounterRoot",
    })
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(CounterRoot.Provider, {
        canon: initialCanon,
        recoveryListeners: { onDeliveryUncertain },
        children,
      })

    const { result } = renderHook(
      () => ({
        first: CounterRoot.useRoot(),
        second: CounterRoot.useRoot(),
      }),
      { wrapper }
    )

    expect(result.current.first).toBe(result.current.second)

    act(() => {
      acceptedLocally(result.current.first.mutate(add({ amount: 1 })))
    })

    expect(result.current.first.value).toBe(1)
    expect(result.current.second.value).toBe(1)
    expect(send).toHaveBeenCalledTimes(1)

    act(() => deliveries[0]?.reject(new Error("response lost")))
    await waitFor(() =>
      expect(onDeliveryUncertain).toHaveBeenCalledWith({
        retry: result.current.first.retryDelivery,
      })
    )
  })

  it("fails at the consumer when no generated provider owns the root", () => {
    const useCounterPredictions = createPredictedRoot({
      protocol: counterProtocol,
      send: createControlledSender().send,
      refresh: useNoRefresh,
    })
    const CounterRoot = createPredictedRootContext(useCounterPredictions, {
      name: "CounterRoot",
    })

    expect(() => renderHook(() => CounterRoot.useRoot())).toThrow(
      "CounterRoot.useRoot must be used within CounterRoot.Provider"
    )
  })
})
