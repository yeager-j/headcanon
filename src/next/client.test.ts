// @vitest-environment jsdom

import type { StandardSchemaV1 } from "@standard-schema/spec"
import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { err, ok, type Result } from "@workspace/result"

import {
  acceptedStamp,
  axisId,
  defineMutation,
  defineProtocol,
  revisionVector,
  type Canon,
} from "../index"
import type { MutationEnvelope } from "../react"
import { createInMemoryInvalidationAdapter } from "../testing"
import {
  createNextObservedRoot,
  createNextPredictedRoot,
  rethrowNextControlFlow,
  useRouterRefresh,
  type NextMutationAction,
} from "./client"

const routerRefresh = vi.hoisted(() => vi.fn())

vi.mock("next/navigation", () => ({
  unstable_rethrow: (error: unknown) => {
    if (
      typeof error === "object" &&
      error !== null &&
      "__nextSignal" in error
    ) {
      throw error
    }
  },
  useRouter: () => ({ refresh: routerRefresh }),
}))

type TestError = { readonly code: "refused" }
type AddArgs = { readonly amount: number }

const addArgsSchema: StandardSchemaV1<unknown, AddArgs> = {
  "~standard": {
    version: 1,
    vendor: "headcanon-next-client-test",
    validate(value) {
      return { value: value as AddArgs }
    },
  },
}

const add = defineMutation({
  name: "next.add",
  args: addArgsSchema,
  predict(state: number, args): Result<number, TestError> {
    return ok(state + args.amount)
  },
})

const protocol = defineProtocol({
  id: "test.next-client.v1",
  mutations: [add],
})
const valueAxis = axisId("next-client/value")

function canon(): Canon<number> {
  const revisions = revisionVector({ [valueAxis]: 0 })
  if (!revisions.ok) throw new Error("Invalid Next client test vector")
  return { value: 0, revisions: revisions.value }
}

function accepted() {
  const revisions = revisionVector({ [valueAxis]: 1 })
  if (!revisions.ok) throw new Error("Invalid Next client test stamp")
  return acceptedStamp(revisions.value)
}

function useRefresh() {
  return { acceptanceGraceMs: 250, request: vi.fn() }
}

afterEach(() => {
  vi.restoreAllMocks()
  routerRefresh.mockReset()
})

describe("Next client binding", () => {
  it("binds App Router refresh with the RSC acceptance grace", () => {
    const { result } = renderHook(() => useRouterRefresh())

    expect(result.current.acceptanceGraceMs).toBe(250)
    act(() => result.current.request())
    expect(routerRefresh).toHaveBeenCalledOnce()
  })

  it("classifies an ordinary thrown Server Action result as uncertain", async () => {
    const rejection = new Error("response lost")
    const useRoot = createNextPredictedRoot({
      protocol,
      send: async (_envelope: MutationEnvelope<ReturnType<typeof add>>) => {
        throw rejection
      },
      refresh: useRefresh,
    })
    const currentCanon = canon()
    const { result } = renderHook(() => useRoot({ canon: currentCanon }))

    act(() => {
      const mutation = result.current.mutate(add({ amount: 1 }))
      if (!mutation.ok) throw new Error("Next client prediction refused")
    })

    await waitFor(() => {
      expect(result.current.status.delivery).toBe("uncertain")
    })
  })

  it.each(["redirect", "not-found", "forbidden", "unauthorized"])(
    "preserves the %s control-flow signal",
    (kind) => {
      const signal = Object.assign(new Error(kind), { __nextSignal: true })

      expect(() => rethrowNextControlFlow(signal)).toThrow(signal)
    }
  )

  it("settles a cancelled mutation before propagating control flow", async () => {
    const signal = Object.assign(new Error("redirect"), {
      __nextSignal: true,
    })
    const propagated = vi.fn()
    const captureSignal = (event: ErrorEvent) => {
      if (event.error !== signal) return
      event.preventDefault()
      propagated(event.error)
    }
    window.addEventListener("error", captureSignal)
    const useRoot = createNextPredictedRoot({
      protocol,
      send: async () => {
        throw signal
      },
      refresh: useRefresh,
    })
    const currentCanon = canon()
    const { result } = renderHook(() => useRoot({ canon: currentCanon }))

    try {
      let receipt: ReturnType<typeof result.current.mutate> | undefined
      act(() => {
        receipt = result.current.mutate(add({ amount: 1 }))
      })
      if (!receipt?.ok) throw new Error("Next client prediction refused")

      const cancellation = err({ kind: "delivery-cancelled" } as const)
      await expect(receipt.value.accepted).resolves.toEqual(cancellation)
      await expect(receipt.value.canonized).resolves.toEqual(cancellation)
      await waitFor(() => {
        expect(result.current.status.pending).toBe(0)
        expect(propagated).toHaveBeenCalledWith(signal)
      })
    } finally {
      window.removeEventListener("error", captureSignal)
    }
  })

  it("returns accepted outcomes unchanged", async () => {
    const stamp = accepted()
    const useRoot = createNextPredictedRoot({
      protocol,
      send: async () => ok(stamp),
      refresh: useRefresh,
    })
    const currentCanon = canon()
    const { result } = renderHook(() => useRoot({ canon: currentCanon }))

    let receipt: ReturnType<typeof result.current.mutate> | undefined
    act(() => {
      receipt = result.current.mutate(add({ amount: 1 }))
    })
    if (!receipt?.ok) throw new Error("Next client prediction refused")

    await expect(receipt.value.accepted).resolves.toEqual(ok(stamp))
  })
})

// UNN-688 spike: the `action`-based golden path.

const refusalSchema: StandardSchemaV1<unknown, TestError> = {
  "~standard": {
    version: 1,
    vendor: "headcanon-next-client-test",
    validate(value) {
      return { value: value as TestError }
    },
  },
}

const guardedAdd = defineMutation({
  name: "next.guarded-add",
  args: addArgsSchema,
  predict(state: number, args): Result<number, TestError> {
    return ok(state + args.amount)
  },
  refusal: refusalSchema,
})

const actionProtocol = defineProtocol({
  id: "test.next-action.v1",
  mutations: [guardedAdd],
})

type GuardedAction = NextMutationAction<typeof actionProtocol>

describe("Next action golden path", () => {
  it("delivers through the generated action and accepts", async () => {
    const stamp = accepted()
    const action: GuardedAction = async () => ok({ kind: "accepted", stamp })
    const useRoot = createNextPredictedRoot({
      protocol: actionProtocol,
      action,
      refresh: useRefresh,
    })
    const currentCanon = canon()
    const { result } = renderHook(() => useRoot({ canon: currentCanon }))

    let receipt: ReturnType<typeof result.current.mutate> | undefined
    act(() => {
      receipt = result.current.mutate(guardedAdd({ amount: 1 }))
    })
    if (!receipt?.ok) throw new Error("Next action prediction refused")

    await expect(receipt.value.accepted).resolves.toEqual(ok(stamp))
  })

  it("maps a rejected terminal outcome onto the domain refusal", async () => {
    const refusal: TestError = { code: "refused" }
    const action: GuardedAction = async () =>
      ok({ kind: "rejected", error: refusal })
    const useRoot = createNextPredictedRoot({
      protocol: actionProtocol,
      action,
      refresh: useRefresh,
    })
    const currentCanon = canon()
    const { result } = renderHook(() => useRoot({ canon: currentCanon }))

    let receipt: ReturnType<typeof result.current.mutate> | undefined
    act(() => {
      receipt = result.current.mutate(guardedAdd({ amount: 1 }))
    })
    if (!receipt?.ok) throw new Error("Next action prediction refused")

    await expect(receipt.value.accepted).resolves.toEqual(
      err({ kind: "domain", error: refusal })
    )
  })

  it("redelivers the same envelope after exhausted authority contention", async () => {
    const stamp = accepted()
    const seen: string[] = []
    const action: GuardedAction = async (envelope) => {
      seen.push(envelope.mutationId)
      return seen.length === 1
        ? err({ code: "contention", mutationId: envelope.mutationId })
        : ok({ kind: "accepted", stamp })
    }
    const useRoot = createNextPredictedRoot({
      protocol: actionProtocol,
      action,
      refresh: useRefresh,
    })
    const currentCanon = canon()
    const { result } = renderHook(() => useRoot({ canon: currentCanon }))

    let receipt: ReturnType<typeof result.current.mutate> | undefined
    act(() => {
      receipt = result.current.mutate(guardedAdd({ amount: 1 }))
    })
    if (!receipt?.ok) throw new Error("Next action prediction refused")

    await expect(receipt.value.accepted).resolves.toEqual(ok(stamp))
    expect(seen).toHaveLength(2)
    expect(seen[0]).toBe(seen[1])
  })

  it("defaults the App Router refresh carrier when no carrier is given", async () => {
    const stamp = accepted()
    const action: GuardedAction = async () => ok({ kind: "accepted", stamp })
    const useRoot = createNextPredictedRoot({
      protocol: actionProtocol,
      action,
    })
    const currentCanon = canon()
    const { result } = renderHook(() => useRoot({ canon: currentCanon }))

    act(() => {
      const mutation = result.current.mutate(guardedAdd({ amount: 1 }))
      if (!mutation.ok) throw new Error("Next action prediction refused")
    })

    // Accepted but uncovered: after the 250 ms RSC grace the root asks the
    // App Router for a fresh canon.
    await waitFor(() => expect(routerRefresh).toHaveBeenCalled(), {
      timeout: 2000,
    })
  })

  it("rejects an action generated for a different protocol", () => {
    const foreign: NextMutationAction<typeof protocol> = async () =>
      err({ code: "invalid-envelope", reason: "invalid-protocol" })

    createNextPredictedRoot({
      protocol: actionProtocol,
      // @ts-expect-error — the action's envelope belongs to another protocol.
      action: foreign,
    })
  })

  it("rejects a refusal-compatible action from a different protocol", () => {
    // The real generated shape: an `unknown` envelope parameter (strict
    // server-side admission) contributes no protocol evidence, and this
    // protocol's refusal union is identical to actionProtocol's — so only
    // the outcome's phantom protocol identity distinguishes the two.
    const twinProtocol = defineProtocol({
      id: "test.next-action-twin.v1",
      mutations: [
        defineMutation({
          name: "next.twin-add",
          args: addArgsSchema,
          predict(state: number, args): Result<number, TestError> {
            return ok(state + args.amount)
          },
          refusal: refusalSchema,
        }),
      ],
    })
    const generatedForTwin: (
      envelope: unknown
    ) => ReturnType<NextMutationAction<typeof twinProtocol>> = async () =>
      ok({ kind: "accepted", stamp: accepted() })

    // The control's premise: distinct protocols, identical refusal shape.
    expect(twinProtocol.id).not.toBe(actionProtocol.id)
    createNextPredictedRoot({
      protocol: actionProtocol,
      // @ts-expect-error — same refusal shape, wrong protocol identity.
      action: generatedForTwin,
    })
  })
})

describe("createNextObservedRoot", () => {
  it("defaults the App Router refresh carrier", async () => {
    const invalidations = createInMemoryInvalidationAdapter()
    const useRoot = createNextObservedRoot({ invalidations })
    const currentCanon = canon()
    const { result } = renderHook(() => useRoot({ canon: currentCanon }))

    expect(result.current.value).toBe(0)
    // A genuinely fresher invalidation leaves the covered state and requests
    // a canon through the defaulted App Router carrier.
    act(() => invalidations.publish("observed-1", accepted()))

    await waitFor(() => expect(routerRefresh).toHaveBeenCalled())
  })

  it("honors an explicit carrier override", async () => {
    const request = vi.fn()
    const invalidations = createInMemoryInvalidationAdapter()
    const useRoot = createNextObservedRoot({
      refresh: () => ({ acceptanceGraceMs: 0, request }),
      invalidations,
    })
    const currentCanon = canon()
    const { result } = renderHook(() => useRoot({ canon: currentCanon }))

    expect(result.current.status.freshness).toBe("current")
    act(() => invalidations.publish("observed-2", accepted()))

    await waitFor(() => expect(request).toHaveBeenCalled())
    expect(routerRefresh).not.toHaveBeenCalled()
  })
})
