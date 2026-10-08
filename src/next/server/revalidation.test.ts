import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  announceExternalCommit,
  axisCacheTag,
  defineCachedCanon,
  finalizeExternalActionCommit,
  MAX_CACHED_CANON_AXES,
} from "."
import {
  acceptedStamp,
  axisId,
  revisionEntries,
  type AcceptedStamp,
  type InvalidationPublisher,
} from "../.."
import { ablyAxisChannelName } from "../../ably/channel-names"
import { ablyChannelNamespace } from "../../ably/channels"

const nextCache = vi.hoisted(() => ({
  cacheTag: vi.fn(),
  refresh: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
}))

vi.mock("next/cache", () => nextCache)

function stamp(entries: Record<string, number>): AcceptedStamp {
  const parsed = acceptedStamp({ revisions: entries })
  if (!parsed.ok) throw new Error("Invalid Next server test stamp")
  return parsed.value
}

function recordingPublisher(events: string[]): InvalidationPublisher {
  return {
    onFailure: () => undefined,
    publish(eventId, accepted) {
      for (const [axis, revision] of revisionEntries(accepted.revisions)) {
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
  // Hashing bounds the tag's length and keeps it a safe tag name. The axis is
  // not confidential: hashing is not there to hide it.
  it("derives a bounded, versioned SHA-256 tag from an axis of any length", async () => {
    const axis = axisId(`entity/${"x".repeat(1_000)}`)
    const tag = await axisCacheTag(axis)

    expect(tag).toMatch(/^headcanon:axis:v1:[0-9a-f]{64}$/)
    expect(tag.length).toBeLessThanOrEqual(256)
    expect(await axisCacheTag(axis)).toBe(tag)
  })

  it("hashes an axis exactly as the Ably channel derivation does", async () => {
    const axis = axisId("entity/shared")
    const channel = await ablyAxisChannelName(
      ablyChannelNamespace("production"),
      axis
    )

    expect(await axisCacheTag(axis)).toBe(
      `headcanon:axis:v1:${channel.split(":").at(-1)}`
    )
  })

  it("parses the loader's observation and tags every axis in one call", async () => {
    const canon = await defineCachedCanon({
      value: "canon",
      revisions: { "entity/one": 1, "entity/two": 2 },
    })

    expect(canon).toEqual({
      value: "canon",
      revisions: { "entity/one": 1, "entity/two": 2 },
    })
    expect(Object.isFrozen(canon)).toBe(true)
    expect(nextCache.cacheTag).toHaveBeenCalledOnce()
    expect(nextCache.cacheTag).toHaveBeenCalledWith(
      await axisCacheTag(axisId("entity/one")),
      await axisCacheTag(axisId("entity/two"))
    )
  })

  it("rejects an invalid revision like defineCanon, before tagging", async () => {
    await expect(
      defineCachedCanon({ value: null, revisions: { "entity/one": -1 } })
    ).rejects.toThrow(
      'defineCanon received an invalid revision vector: invalid-revision-vector at axis "entity/one" (negative)'
    )
    expect(nextCache.cacheTag).not.toHaveBeenCalled()
  })

  it("fails before cacheTag can accept a partial 129-axis entry", async () => {
    const revisions = Object.fromEntries(
      Array.from({ length: MAX_CACHED_CANON_AXES + 1 }, (_, index) => [
        `axis/${index}`,
        index,
      ])
    )

    await expect(defineCachedCanon({ value: null, revisions })).rejects.toThrow(
      RangeError
    )
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

    await finalizeExternalActionCommit(accepted, recordingPublisher(events))

    expect(events.slice(0, 2)).toEqual([
      `update:${await axisCacheTag(first)}`,
      `update:${await axisCacheTag(second)}`,
    ])
    expect(events[2]).toBe("refresh")
    const published = events.slice(3, 5)
    expect(published).toHaveLength(2)
    expect(published[0]?.split(":")[1]).toBe(published[1]?.split(":")[1])
  })

  it("uses immediate revalidation outside a Server Action and never refreshes", async () => {
    await announceExternalCommit(accepted, {
      publish: vi.fn(),
      onFailure: vi.fn(),
    })

    expect(nextCache.revalidateTag.mock.calls).toEqual([
      [await axisCacheTag(first), { expire: 0 }],
      [await axisCacheTag(second), { expire: 0 }],
    ])
    expect(nextCache.updateTag).not.toHaveBeenCalled()
    expect(nextCache.refresh).not.toHaveBeenCalled()
  })

  it("expires and refreshes with no publisher when there is no realtime", async () => {
    await expect(
      finalizeExternalActionCommit(accepted)
    ).resolves.toBeUndefined()

    expect(nextCache.updateTag).toHaveBeenCalledTimes(2)
    expect(nextCache.refresh).toHaveBeenCalledOnce()
  })

  it("expires outside a Server Action with no publisher when there is no realtime", async () => {
    await expect(announceExternalCommit(accepted)).resolves.toBeUndefined()

    expect(nextCache.revalidateTag).toHaveBeenCalledTimes(2)
    expect(nextCache.refresh).not.toHaveBeenCalled()
  })

  it("keeps publication failure advisory and still refreshes the invoking route", async () => {
    const onFailure = vi.fn()
    const error = new Error("realtime unavailable")
    await expect(
      finalizeExternalActionCommit(accepted, {
        publish: async () => {
          throw error
        },
        onFailure,
      })
    ).resolves.toBeUndefined()

    expect(nextCache.updateTag).toHaveBeenCalledTimes(2)
    expect(nextCache.refresh).toHaveBeenCalledOnce()
    expect(onFailure).toHaveBeenCalledExactlyOnceWith({
      kind: "rejected",
      eventId: expect.any(String),
      stamp: accepted,
      error,
    })

    await expect(
      finalizeExternalActionCommit(accepted, {
        publish: async () => Promise.reject(error),
        onFailure: () => {
          throw new Error("diagnostics unavailable")
        },
      })
    ).resolves.toBeUndefined()
  })

  it("bounds stalled advisory publication after refreshing the route", async () => {
    vi.useFakeTimers()
    const onFailure = vi.fn()
    const finalization = finalizeExternalActionCommit(accepted, {
      publish: () => new Promise<void>(() => undefined),
      onFailure,
    })
    const settled = vi.fn()
    void finalization.then(settled)

    // Axis tags are hashed with WebCrypto, so expiry follows an async hop.
    await vi.waitFor(() => expect(nextCache.refresh).toHaveBeenCalledOnce())
    expect(nextCache.updateTag).toHaveBeenCalledTimes(2)
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()

    await vi.runAllTimersAsync()

    await expect(finalization).resolves.toBeUndefined()
    expect(settled).toHaveBeenCalledOnce()
    expect(onFailure).toHaveBeenCalledExactlyOnceWith({
      kind: "timed-out",
      eventId: expect.any(String),
      stamp: accepted,
    })
  })
})
