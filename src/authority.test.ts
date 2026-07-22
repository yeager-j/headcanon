import { describe, expect, it } from "vitest"

import { axisId, createStampAccumulator } from "./index"

describe("stamp accumulator", () => {
  it("owns raw revision validation and returns branded accepted stamps", () => {
    const stamp = createStampAccumulator()

    stamp.record(axisId("entity/one"), 2)

    const accepted = stamp.accepted()
    expect(accepted).toEqual({
      revisions: { "entity/one": 2 },
    })
    expect(Object.isFrozen(accepted)).toBe(true)
    expect(Object.isFrozen(accepted.revisions)).toBe(true)
    expect(() => stamp.record(axisId("entity/two"), Number.NaN)).toThrow(
      "Invalid stamped revision for axis: entity/two"
    )
  })

  it("rejects regression on an axis while accepting equal redelivery", () => {
    const stamp = createStampAccumulator()
    const axis = axisId("entity/one")

    stamp.record(axis, 2)
    stamp.record(axis, 2)

    expect(() => stamp.record(axis, 1)).toThrow(
      "Revision regressed while stamping axis: entity/one"
    )
  })
})
