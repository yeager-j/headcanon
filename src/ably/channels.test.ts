import { describe, expect, it } from "vitest"

import { ablyChannelNamespace } from "./channels"

describe("ablyChannelNamespace", () => {
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
})
