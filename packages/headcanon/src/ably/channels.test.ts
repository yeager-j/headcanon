import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"

import { axisId } from "../revisions"
import {
  ablyAxisChannelName,
  ablyCapabilityByteLength,
  ablySubscribeCapability,
} from "./channels"

describe("Ably axis channels", () => {
  it("derives a stable deployment-scoped SHA-256 channel", async () => {
    const axis = axisId("secret/storage/axis")
    const digest = createHash("sha256").update(axis, "utf8").digest("hex")

    await expect(ablyAxisChannelName("preview-671", axis)).resolves.toBe(
      `preview-671:headcanon:axis:v1:${digest}`
    )
    await expect(ablyAxisChannelName("", axis)).rejects.toThrow(
      "namespace is required"
    )
  })

  it("enumerates exact subscribe-only capabilities deterministically", () => {
    expect(
      ablySubscribeCapability(["channel:b", "channel:a", "channel:b"])
    ).toEqual({
      "channel:a": ["subscribe"],
      "channel:b": ["subscribe"],
    })
  })

  it("measures a combat-scale exact capability claim", async () => {
    const channels = await Promise.all(
      Array.from({ length: 128 }, (_, index) =>
        ablyAxisChannelName("production", axisId(`combatant/${index}`))
      )
    )
    const capability = ablySubscribeCapability(channels)
    const measuredBytes = ablyCapabilityByteLength(capability)

    expect(Object.keys(capability)).toHaveLength(128)
    expect(measuredBytes).toBe(
      new TextEncoder().encode(JSON.stringify(capability)).byteLength
    )
    expect(measuredBytes).toBe(14_081)
  })
})
