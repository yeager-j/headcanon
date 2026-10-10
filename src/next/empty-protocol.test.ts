// @vitest-environment jsdom

import type { StandardSchemaV1 } from "@standard-schema/spec"
import { renderHook } from "@testing-library/react"
import { err, ok } from "serializable-result"
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest"

import { defineCanon, defineMutation, defineProtocol } from ".."
import type { ProtocolState } from "../core/protocol"
import { sessionStoragePersistence } from "../react"
import { createMutationBinder } from "../server"
import { createInMemoryMutationAuthority } from "../testing"
import { createNextPredictedRoot } from "./client"
import { createNextMutationAction } from "./server"

vi.mock("next/cache", () => ({
  cacheTag: vi.fn(),
  refresh: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
}))

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRouter: () => ({ refresh: vi.fn() }),
}))

type RunState = { readonly name: string }

const runProtocol = defineProtocol<RunState>()({ id: "run.v1", mutations: [] })

const QUEUE_KEY = "run-queue:player-1:run-1"

function createRunAction() {
  const actor = vi.fn(() => "player-1")
  const binder = createMutationBinder({
    actor,
    authority: createInMemoryMutationAuthority<RunState, string, unknown>({
      initialState: { name: "" },
      scope: (player) => player,
    }),
  })
  const action = createNextMutationAction({
    protocol: runProtocol,
    binder,
    commands: [],
  })

  return { action, actor }
}

const runCanon = defineCanon({
  value: { name: "Emerald" } satisfies RunState,
  revisions: {},
})

beforeEach(() => {
  globalThis.sessionStorage.clear()
})

describe("a protocol with no mutations yet", () => {
  it("keeps the declared state type", () => {
    expectTypeOf<ProtocolState<typeof runProtocol>>().toEqualTypeOf<RunState>()
  })

  it("makes an action with no commands that refuses every envelope", async () => {
    const { action, actor } = createRunAction()

    expect(
      await action({
        protocol: "run.v1",
        scope: "actor",
        mutationId: "00000000-0000-4000-8000-000000000001",
        createdAt: Date.now(),
        invocation: { name: "run.rename", args: {} },
      })
    ).toEqual(err({ code: "invalid-envelope", reason: "unknown-mutation" }))
    expect(actor).not.toHaveBeenCalled()
  })

  it("mounts a root whose mutate takes no invocation", () => {
    const { action } = createRunAction()
    const useRun = createNextPredictedRoot({
      protocol: runProtocol,
      scope: () => "actor",
      action,
    })

    const { result } = renderHook(() =>
      useRun({
        canon: runCanon,
      })
    )

    expect(result.current.value).toEqual({ name: "Emerald" })
    expect(result.current.status.pending).toBe(0)
    expectTypeOf(result.current.value).toEqualTypeOf<RunState>()
    expectTypeOf(result.current.mutate).parameter(0).toBeNever()
  })

  it("restores an empty or unusable stored queue without throwing", () => {
    const { action } = createRunAction()
    const useRun = createNextPredictedRoot({
      protocol: runProtocol,
      scope: () => "actor",
      action,
      persistence: sessionStoragePersistence(QUEUE_KEY),
    })

    for (const stored of [
      "[]",
      JSON.stringify([
        {
          protocol: "run.v1",
          scope: "actor",
          mutationId: "00000000-0000-4000-8000-000000000002",
          createdAt: Date.now(),
          invocation: { name: "run.rename", args: { name: "Ruby" } },
        },
      ]),
    ]) {
      globalThis.sessionStorage.setItem(QUEUE_KEY, stored)
      const { result, unmount } = renderHook(() => useRun({ canon: runCanon }))

      expect(result.current.value).toEqual({ name: "Emerald" })
      expect(result.current.status.pending).toBe(0)
      expect(result.current.status.delivery).toBe("idle")
      unmount()
    }
  })

  it("checks each later mutation against the declared state", () => {
    const nameArgs: StandardSchemaV1<unknown, { readonly name: string }> = {
      "~standard": {
        version: 1,
        vendor: "headcanon-test",
        validate: (value) => ({ value: value as { readonly name: string } }),
      },
    }
    const renameRun = defineMutation({
      name: "run.rename",
      args: nameArgs,
      predict: (state: RunState, args) => ok({ ...state, name: args.name }),
    })
    const countRuns = defineMutation({
      name: "run.count",
      args: nameArgs,
      predict: (state: number) => ok(state + 1),
    })

    const renamed = defineProtocol<RunState>()({
      id: "run.v1",
      mutations: [renameRun],
    })
    expectTypeOf<ProtocolState<typeof renamed>>().toEqualTypeOf<RunState>()

    defineProtocol<RunState>()({
      id: "run.v1",
      // @ts-expect-error — run.count predicts a number, not RunState.
      mutations: [renameRun, countRuns],
    })
  })
})
