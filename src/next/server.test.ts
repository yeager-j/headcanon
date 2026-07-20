import type { StandardSchemaV1 } from "@standard-schema/spec"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ok, type Result } from "@workspace/result"

import {
  acceptedStamp,
  axisId,
  defineMutation,
  defineProtocol,
  revision,
  revisionVector,
  type AcceptedStamp,
  type InvalidationPublisher,
  type MutationAuthorityAdapter,
} from "../index"
import { createInMemoryMutationAuthority } from "../testing"
import {
  announceExternalCommit,
  axisCacheTag,
  createNextMutationExecutor,
  finalizeExternalActionCommit,
  MAX_VERSIONED_BASE_AXES,
  tagVersionedBase,
} from "./server"

const nextCache = vi.hoisted(() => ({
  cacheTag: vi.fn(),
  refresh: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
}))

vi.mock("next/cache", () => nextCache)

function stamp(entries: Record<string, number>): AcceptedStamp {
  const revisions = revisionVector(entries)
  if (!revisions.ok) throw new Error("Invalid Next server test stamp")
  return acceptedStamp(revisions.value)
}

function recordingPublisher(events: string[]): InvalidationPublisher {
  return {
    publish(eventId, accepted) {
      for (const [axis, revision] of Object.entries(accepted.revisions)) {
        events.push(`publish:${eventId}:${axis}:${revision}`)
      }
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("axis cache tags", () => {
  it("derives a bounded, versioned SHA-256 tag without exposing the axis", () => {
    const axis = axisId(`secret/${"x".repeat(1_000)}`)
    const tag = axisCacheTag(axis)

    expect(tag).toMatch(/^headcanon:axis:v1:[0-9a-f]{64}$/)
    expect(tag.length).toBeLessThanOrEqual(256)
    expect(tag).not.toContain(axis)
    expect(axisCacheTag(axis)).toBe(tag)
  })

  it("tags every observed axis in one cacheTag call and preserves identity", () => {
    const base = {
      value: "canon",
      revisions: stamp({ "entity/one": 1, "entity/two": 2 }).revisions,
    }

    expect(tagVersionedBase(base)).toBe(base)
    expect(nextCache.cacheTag).toHaveBeenCalledOnce()
    expect(nextCache.cacheTag).toHaveBeenCalledWith(
      axisCacheTag(axisId("entity/one")),
      axisCacheTag(axisId("entity/two"))
    )
  })

  it("fails before cacheTag can accept a partial 129-axis entry", () => {
    const revisions = Object.fromEntries(
      Array.from({ length: MAX_VERSIONED_BASE_AXES + 1 }, (_, index) => [
        `axis/${index}`,
        index,
      ])
    )
    const base = { value: null, revisions: stamp(revisions).revisions }

    expect(() => tagVersionedBase(base)).toThrow(RangeError)
    expect(nextCache.cacheTag).not.toHaveBeenCalled()
  })
})

describe("Next commit finalization", () => {
  const first = axisId("entity/first")
  const second = axisId("entity/second")
  const accepted = stamp({ [first]: 3, [second]: 5 })

  it("expires every axis, refreshes, then publishes one shared event", async () => {
    const events: string[] = []
    nextCache.updateTag.mockImplementation((tag) => {
      events.push(`update:${tag}`)
    })
    nextCache.refresh.mockImplementation(() => {
      events.push("refresh")
    })

    await finalizeExternalActionCommit(
      accepted,
      recordingPublisher(events),
      vi.fn()
    )

    expect(events.slice(0, 2)).toEqual([
      `update:${axisCacheTag(first)}`,
      `update:${axisCacheTag(second)}`,
    ])
    expect(events[2]).toBe("refresh")
    const published = events.slice(3, 5)
    expect(published).toHaveLength(2)
    expect(published[0]?.split(":")[1]).toBe(published[1]?.split(":")[1])
  })

  it("uses immediate revalidation outside a Server Action and never refreshes", async () => {
    await announceExternalCommit(accepted, { publish: vi.fn() }, vi.fn())

    expect(nextCache.revalidateTag.mock.calls).toEqual([
      [axisCacheTag(first), { expire: 0 }],
      [axisCacheTag(second), { expire: 0 }],
    ])
    expect(nextCache.updateTag).not.toHaveBeenCalled()
    expect(nextCache.refresh).not.toHaveBeenCalled()
  })

  it("keeps publication failure advisory and still refreshes the invoking route", async () => {
    const reportFailure = vi.fn()
    const error = new Error("realtime unavailable")
    await expect(
      finalizeExternalActionCommit(
        accepted,
        {
          publish: async () => {
            throw error
          },
        },
        reportFailure
      )
    ).resolves.toBeUndefined()

    expect(nextCache.updateTag).toHaveBeenCalledTimes(2)
    expect(nextCache.refresh).toHaveBeenCalledOnce()
    expect(reportFailure).toHaveBeenCalledExactlyOnceWith({
      kind: "rejected",
      eventId: expect.any(String),
      stamp: accepted,
      error,
    })

    await expect(
      finalizeExternalActionCommit(
        accepted,
        { publish: async () => Promise.reject(error) },
        () => {
          throw new Error("diagnostics unavailable")
        }
      )
    ).resolves.toBeUndefined()
  })

  it("bounds stalled advisory publication after refreshing the route", async () => {
    vi.useFakeTimers()
    const reportFailure = vi.fn()
    const finalization = finalizeExternalActionCommit(
      accepted,
      {
        publish: () => new Promise<void>(() => undefined),
      },
      reportFailure
    )
    const settled = vi.fn()
    void finalization.then(settled)

    expect(nextCache.updateTag).toHaveBeenCalledTimes(2)
    expect(nextCache.refresh).toHaveBeenCalledOnce()
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()

    await vi.runAllTimersAsync()

    await expect(finalization).resolves.toBeUndefined()
    expect(settled).toHaveBeenCalledOnce()
    expect(reportFailure).toHaveBeenCalledExactlyOnceWith({
      kind: "timed-out",
      eventId: expect.any(String),
      stamp: accepted,
    })
  })
})

type IncrementArgs = { readonly amount: number }
type Rejection = { readonly code: "refused" }

const incrementSchema: StandardSchemaV1<unknown, IncrementArgs> = {
  "~standard": {
    version: 1,
    vendor: "headcanon-next-server-test",
    validate(value) {
      return { value: value as IncrementArgs }
    },
  },
}

const increment = defineMutation({
  name: "next.increment",
  args: incrementSchema,
  predict(state: number, args): Result<number, Rejection> {
    return ok(state + args.amount)
  },
})
const protocol = defineProtocol({
  id: "test.next-server.v1",
  mutations: [increment],
})

describe("Next mutation executor", () => {
  it("finalizes an accepted authority outcome before returning it", async () => {
    const accepted = stamp({ "counter/value": 2 })
    const authority: MutationAuthorityAdapter<
      Record<string, never>,
      string,
      Rejection
    > = {
      async execute(_request, run) {
        const handled = await run({}, { record: vi.fn() })
        if (!handled.ok) throw new Error("Unexpected handler rejection")
        return ok({ kind: "accepted", stamp: accepted })
      },
    }
    const invalidations = { publish: vi.fn() }
    const execute = createNextMutationExecutor({
      protocol,
      authority,
      handlers: {
        "next.increment": () => ok(undefined),
      },
      invalidations,
      reportInvalidationFailure: vi.fn(),
    })

    const result = await execute(
      {
        protocol: protocol.id,
        mutationId: "d1501828-4d5e-4d7b-b79b-98c5e2576dde",
        invocation: increment({ amount: 1 }),
      },
      "actor"
    )

    expect(result).toEqual(ok({ kind: "accepted", stamp: accepted }))
    expect(nextCache.updateTag).toHaveBeenCalledWith(
      axisCacheTag(axisId("counter/value"))
    )
    expect(invalidations.publish).toHaveBeenCalledOnce()
    expect(nextCache.refresh).toHaveBeenCalledOnce()
  })

  it("repeats finalization from the recorded stamp on duplicate delivery", async () => {
    const authority = createInMemoryMutationAuthority<
      number,
      string,
      Rejection
    >({ initialState: 0, scope: (actor) => actor })
    const invalidations = { publish: vi.fn() }
    const counterAxis = axisId("counter/value")
    const execute = createNextMutationExecutor({
      protocol,
      authority,
      handlers: {
        "next.increment": ({ tx, args, stamp }) => {
          const next = tx.read() + args.amount
          const stampedRevision = revision(next)
          if (!stampedRevision.ok) throw new Error("Invalid counter revision")
          tx.write(next)
          stamp.record(counterAxis, stampedRevision.value)
          return ok(undefined)
        },
      },
      invalidations,
      reportInvalidationFailure: vi.fn(),
    })
    const envelope = {
      protocol: protocol.id,
      mutationId: "73da9d18-9796-44b6-8bc1-066d9ca24fbb",
      invocation: increment({ amount: 1 }),
    }

    const first = await execute(envelope, "actor")
    const duplicate = await execute(envelope, "actor")

    expect(authority.read()).toBe(1)
    expect(duplicate).toEqual(first)
    expect(invalidations.publish).toHaveBeenCalledTimes(2)
    expect(invalidations.publish.mock.calls[0]?.[1]).toEqual(
      invalidations.publish.mock.calls[1]?.[1]
    )
  })
})
