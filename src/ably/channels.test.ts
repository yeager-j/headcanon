import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"

import { axisId } from "../revisions"
import {
  ABLY_AXIS_INVALIDATION_EVENT,
  ablyAxisChannelName,
  ablyChannelNamespace,
  ablySubscribeCapability,
} from "./channels"

describe("Ably axis channels", () => {
  it("derives a stable deployment-scoped SHA-256 channel", async () => {
    const axis = axisId("entity/storage/axis")
    const digest = createHash("sha256").update(axis, "utf8").digest("hex")

    await expect(
      ablyAxisChannelName(ablyChannelNamespace("preview-671"), axis)
    ).resolves.toBe(`preview-671:headcanon:axis:v1:${digest}`)
    expect(ABLY_AXIS_INVALIDATION_EVENT).toBe("headcanon.axis-invalidation.v1")
  })

  it("parses a namespace without rewriting it", () => {
    for (const namespace of ["production", "app:preview-42", "a.b_c"]) {
      expect(ablyChannelNamespace(namespace)).toBe(namespace)
    }
    for (const namespace of [
      "",
      " production",
      "production ",
      "production:",
      ":production",
      "app::preview",
      "[meta]production",
    ]) {
      expect(() => ablyChannelNamespace(namespace)).toThrow(
        "Invalid Ably axis-channel namespace"
      )
    }
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
    const namespace = ablyChannelNamespace("production")
    const channels = await Promise.all(
      Array.from({ length: 128 }, (_, index) =>
        ablyAxisChannelName(namespace, axisId(`combatant/${index}`))
      )
    )
    const capability = ablySubscribeCapability(channels)

    expect(Object.keys(capability)).toHaveLength(128)
    expect(
      new TextEncoder().encode(JSON.stringify(capability)).byteLength
    ).toBe(14_081)
  })
})
