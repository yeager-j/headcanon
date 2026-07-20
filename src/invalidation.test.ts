import { describe, expect, it } from "vitest"

import { axisInvalidation } from "./invalidation"
import { axisId } from "./revisions"

describe("axisInvalidation", () => {
  it("parses exactly one singleton axis revision", () => {
    expect(
      axisInvalidation({
        eventId: "event-1",
        axis: "entity/one",
        revision: 3,
      })
    ).toEqual({
      ok: true,
      value: {
        eventId: "event-1",
        axis: axisId("entity/one"),
        revision: 3,
      },
    })
  })

  it.each([
    null,
    [],
    { eventId: "event-1", axis: "entity/one", revision: 1, hp: 10 },
    { eventId: "", axis: "entity/one", revision: 1 },
    { eventId: "event-1", axis: "", revision: 1 },
    { eventId: "event-1", axis: "entity/one", revision: -1 },
    { eventId: "event-1", axis: "entity/one", revision: 1.5 },
    { eventId: "event-1", axis: "entity/one", revision: "1" },
  ])("rejects malformed or domain-bearing payload %#", (payload) => {
    expect(axisInvalidation(payload).ok).toBe(false)
  })

  it("rejects hidden and symbol-keyed domain data", () => {
    const hidden = { eventId: "event-1", axis: "entity/one", revision: 1 }
    Object.defineProperty(hidden, "hp", { value: 10 })
    const symbol = {
      eventId: "event-1",
      axis: "entity/one",
      revision: 1,
      [Symbol("hp")]: 10,
    }

    expect(axisInvalidation(hidden).ok).toBe(false)
    expect(axisInvalidation(symbol).ok).toBe(false)
  })
})
