// @vitest-environment jsdom

import type { StandardSchemaV1 } from "@standard-schema/spec"
import { act, renderHook, waitFor } from "@testing-library/react"
import { forbidden, notFound, redirect, unauthorized } from "next/navigation"
import { err, ok, type Result } from "serializable-result"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  acceptedStamp,
  axisId,
  defineMutation,
  defineProtocol,
  revisionVector,
  type Canon,
  type MutationEnvelope,
} from ".."
import type { PredictedRootOptions } from "../react"
import { createInMemoryInvalidationAdapter } from "../testing"
import {
  createNextObservedRoot,
  createNextPredictedRoot,
  ROUTER_ACCEPTANCE_GRACE_MS,
  useRouterRefresh,
  type NextActionPredictedRootOptions,
  type NextMutationAction,
} from "./client"

const routerRefresh = vi.hoisted(() => vi.fn())

// Only the router is faked. `unstable_rethrow` and the control-flow helpers
// are Next's own, so classification is checked against real digest-tagged
// errors.
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<object>()),
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

function canon(): Canon<number> {
  const revisions = revisionVector({ [valueAxis]: 0 })
  if (!revisions.ok) throw new Error("Invalid Next client test vector")
  return { value: 0, revisions: revisions.value }
}

function accepted() {
  const stamp = acceptedStamp({ revisions: { [valueAxis]: 1 } })
  if (!stamp.ok) throw new Error("Invalid Next client test stamp")
  return stamp.value
}

function useRefresh() {
  return { acceptanceGraceMs: ROUTER_ACCEPTANCE_GRACE_MS, request: vi.fn() }
}

/** Captures the error `raise` throws: the real signal a Server Action raises. */
function thrownBy(raise: () => never): unknown {
  try {
    raise()
  } catch (error) {
    return error
  }
}

/** Mounts a root over `action` and records one mutation. */
function mountAction(
  action: GuardedAction,
  options: Partial<NextActionPredictedRootOptions<typeof actionProtocol>> = {}
) {
  const useRoot = createNextPredictedRoot({
    protocol: actionProtocol,
    action,
    refresh: useRefresh,
    ...options,
  })
  const currentCanon = canon()
  const rendered = renderHook(() => useRoot({ canon: currentCanon }))
  let receipt: ReturnType<typeof rendered.result.current.mutate> | undefined
  act(() => {
    receipt = rendered.result.current.mutate(guardedAdd({ amount: 1 }))
  })
  if (!receipt?.ok) throw new Error("Next action prediction refused")
  return { ...rendered, receipt: receipt.value }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  routerRefresh.mockReset()
})

describe("Next client binding", () => {
  it("binds App Router refresh with the RSC acceptance grace", () => {
    const { result } = renderHook(() => useRouterRefresh())

    expect(result.current.acceptanceGraceMs).toBe(ROUTER_ACCEPTANCE_GRACE_MS)
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

  it.each([
    ["redirect()", () => redirect("/elsewhere")],
    ["notFound()", () => notFound()],
    ["forbidden()", () => forbidden()],
    ["unauthorized()", () => unauthorized()],
  ])(
    "cancels the mutation and propagates %s from the Server Action",
    async (_name, raise) => {
      // forbidden() and unauthorized() raise their signal only when the app
      // enables `experimental.authInterrupts`.
      vi.stubEnv("__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS", "true")
      const signal = thrownBy(raise)
      expect(signal).toHaveProperty("digest")
      const propagated = vi.fn()
      const captureSignal = (event: ErrorEvent) => {
        if (event.error !== signal) return
        event.preventDefault()
        propagated(event.error)
      }
      window.addEventListener("error", captureSignal)

      try {
        const { receipt, result } = mountAction(async () => {
          throw signal
        })
        const cancellation = err({ kind: "delivery-cancelled" } as const)
        await expect(receipt.accepted).resolves.toEqual(cancellation)
        await expect(receipt.canonized).resolves.toEqual(cancellation)
        await waitFor(() => {
          expect(result.current.status.pending).toBe(0)
          expect(propagated).toHaveBeenCalledWith(signal)
        })
        expect(result.current.status.delivery).toBe("idle")
      } finally {
        window.removeEventListener("error", captureSignal)
      }
    }
  )

  it("propagates a control-flow signal nested as an error cause", async () => {
    const signal = thrownBy(() => redirect("/elsewhere"))
    const wrapped = new Error("wrapped by the application", { cause: signal })
    const propagated = vi.fn()
    const captureSignal = (event: ErrorEvent) => {
      if (event.error !== signal) return
      event.preventDefault()
      propagated(event.error)
    }
    window.addEventListener("error", captureSignal)

    try {
      const { receipt } = mountAction(async () => {
        throw wrapped
      })
      await expect(receipt.accepted).resolves.toEqual(
        err({ kind: "delivery-cancelled" })
      )
      await waitFor(() => expect(propagated).toHaveBeenCalledWith(signal))
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

  it("defaults the explicit send form to the App Router carrier", async () => {
    const stamp = accepted()
    const useRoot = createNextPredictedRoot({
      protocol,
      send: async () => ok(stamp),
    })
    const currentCanon = canon()
    const { result } = renderHook(() => useRoot({ canon: currentCanon }))

    act(() => {
      const mutation = result.current.mutate(add({ amount: 1 }))
      if (!mutation.ok) throw new Error("Next client prediction refused")
    })

    await waitFor(() => expect(routerRefresh).toHaveBeenCalled())
  })
})

describe("Next action golden path", () => {
  it("delivers through the generated action and accepts", async () => {
    const stamp = accepted()
    const { receipt } = mountAction(async () => ok({ kind: "accepted", stamp }))

    await expect(receipt.accepted).resolves.toEqual(ok(stamp))
  })

  it("maps a refused terminal outcome onto the domain refusal", async () => {
    const refusal: TestError = { code: "refused" }
    const { receipt } = mountAction(async () =>
      ok({ kind: "refused", error: refusal })
    )

    await expect(receipt.accepted).resolves.toEqual(
      err({ kind: "domain", error: refusal })
    )
  })

  it("settles a denial as terminal, never as a refusal or a retry", async () => {
    const action = vi.fn<GuardedAction>(async () => ok({ kind: "denied" }))
    const { receipt, result } = mountAction(action)

    const denied = err({ kind: "denied" } as const)
    await expect(receipt.accepted).resolves.toEqual(denied)
    await expect(receipt.canonized).resolves.toEqual(denied)
    expect(result.current.value).toBe(0)
    expect(result.current.status.delivery).toBe("idle")
    expect(action).toHaveBeenCalledOnce()
  })

  it.each([
    { code: "invalid-envelope", reason: "invalid-protocol" },
    { code: "invalid-arguments", mutation: "next.guarded-add", issues: [] },
    { code: "mutation-id-reused", mutationId: "reused" },
  ] as const)(
    "settles the executor's $code refusal as undeliverable, without retry",
    async (executorError) => {
      const action = vi.fn<GuardedAction>(async () => err(executorError))
      const { receipt, result } = mountAction(action)

      const undeliverable = err({
        kind: "undeliverable",
        error: executorError,
      } as const)
      await expect(receipt.accepted).resolves.toEqual(undeliverable)
      await expect(receipt.canonized).resolves.toEqual(undeliverable)
      expect(result.current.status.delivery).toBe("idle")
      expect(result.current.status.pending).toBe(0)
      expect(action).toHaveBeenCalledOnce()
    }
  )

  it("redelivers the same envelope after exhausted authority contention", async () => {
    const stamp = accepted()
    const seen: string[] = []
    const { receipt } = mountAction(async (envelope) => {
      seen.push(envelope.mutationId)
      return seen.length === 1
        ? err({ code: "contention", mutationId: envelope.mutationId })
        : ok({ kind: "accepted", stamp })
    })

    await expect(receipt.accepted).resolves.toEqual(ok(stamp))
    expect(seen).toHaveLength(2)
    expect(seen[0]).toBe(seen[1])
  })

  it("forwards every root option it does not replace", async () => {
    const onPrediction = vi.fn()
    const onDeliveryUncertain = vi.fn()
    mountAction(
      async () => {
        throw new Error("response lost")
      },
      {
        mutationListeners: { onPrediction },
        recoveryListeners: { onDeliveryUncertain },
      }
    )

    expect(onPrediction).toHaveBeenCalledOnce()
    await waitFor(() => expect(onDeliveryUncertain).toHaveBeenCalledOnce())
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

    // Accepted but uncovered: after the RSC grace the root asks the App
    // Router for a fresh canon.
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

// Compile-time regression (P2-13): the action form accepts every root option
// except the two it replaces, so a new root option cannot be silently dropped.
type ForwardedRootOption = Exclude<
  keyof PredictedRootOptions<typeof actionProtocol>,
  "send"
>
const _forwardsEveryRootOption: ForwardedRootOption extends keyof NextActionPredictedRootOptions<
  typeof actionProtocol
>
  ? true
  : never = true
void _forwardsEveryRootOption

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
