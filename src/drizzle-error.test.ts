import { describe, expect, it } from "vitest"

import { matchesPostgresError } from "./drizzle"

describe("PostgreSQL error matching", () => {
  it("matches code and constraint through wrapped causes", () => {
    const error = new Error("outer", {
      cause: {
        code: "23505",
        constraint: "dungeon_one_active_per_campaign",
      },
    })

    expect(
      matchesPostgresError(error, {
        code: "23505",
        constraint: "dungeon_one_active_per_campaign",
      })
    ).toBe(true)
    expect(
      matchesPostgresError(error, {
        code: "23505",
        constraint: "another_constraint",
      })
    ).toBe(false)
  })

  it("continues past unrelated wrapper codes and terminates on causal cycles", () => {
    const inner = { code: "40001" } as { code: string; cause?: unknown }
    const outer = { code: "WRAPPED", cause: inner }
    inner.cause = outer

    expect(matchesPostgresError(outer, { code: "40001" })).toBe(true)
    expect(matchesPostgresError(outer, { code: "55P03" })).toBe(false)
  })
})
