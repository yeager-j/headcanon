import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"

import { axisId } from "../core/revisions"
import {
  ABLY_AXIS_INVALIDATION_EVENT,
  ablyAxisChannelName,
  ablySubscribeCapability,
} from "./channel-names"
import { ablyChannelNamespace } from "./channels"

describe("Ably axis channels", () => {
  it("derives a stable deployment-scoped SHA-256 channel and the v1 event name", async () => {
    const axis = axisId("entity/storage/axis")
    const digest = createHash("sha256").update(axis, "utf8").digest("hex")

    await expect(
      ablyAxisChannelName(ablyChannelNamespace("preview-671"), axis)
    ).resolves.toBe(`preview-671:headcanon:axis:v1:${digest}`)
    expect(ABLY_AXIS_INVALIDATION_EVENT).toBe("headcanon.axis-invalidation.v1")
  })

  it("enumerates exact subscribe-only capabilities deterministically", () => {
    expect(
      ablySubscribeCapability(["channel:b", "channel:a", "channel:b"])
    ).toEqual({
      "channel:a": ["subscribe"],
      "channel:b": ["subscribe"],
    })
  })

  it("pins the JSON size of a 128-channel capability claim", async () => {
    const channelCount = 128
    const namespace = ablyChannelNamespace("production")
    const channels = await Promise.all(
      Array.from({ length: channelCount }, (_, index) =>
        ablyAxisChannelName(namespace, axisId(`combatant/${index}`))
      )
    )
    const capability = ablySubscribeCapability(channels)

    expect(Object.keys(capability)).toHaveLength(channelCount)
    expect(
      new TextEncoder().encode(JSON.stringify(capability)).byteLength
    ).toBe(14_081)
  })
})
