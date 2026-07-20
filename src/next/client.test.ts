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
import {
  createNextPredictedRoot,
  rethrowNextControlFlow,
  useRouterRefresh,
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
