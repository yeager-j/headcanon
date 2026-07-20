import { describe, expect, it } from "vitest"

// @ts-expect-error — depcheck.mjs is a plain JS gate script with no declarations.
import * as depcheck from "../depcheck.mjs"

describe("headcanon shared-entry dependency gate", () => {
  it.each([
    ['import { createHash } from "node:crypto"', "node:crypto"],
    [
      'import { db } from "@neondatabase/serverless"',
      "@neondatabase/serverless",
    ],
    ['import "server-only"', "server-only"],
    ['export { run } from "next/server"', "next/server"],
  ])("rejects a forbidden shared dependency", (source, specifier) => {
    expect(depcheck.scanSource("src/index.ts", source)).toEqual([
      expect.objectContaining({
        file: "src/index.ts",
        specifier,
        rule: "server dependency in client graph",
      }),
    ])
  })

  it("rejects server directives and secret-bearing environment access", () => {
    expect(
      depcheck.scanSource(
        "src/server-handler.ts",
        `'use server'\nconst secret = process.env.AUTH_SECRET`
      )
    ).toEqual([
      expect.objectContaining({ rule: "server directive in client graph" }),
      expect.objectContaining({ rule: "environment access in client graph" }),
    ])
  })

  it("keeps the real client entry graphs bundle-safe", () => {
    expect(depcheck.scanClientEntries()).toEqual([])
  })

  it("keeps the shared entry independently framework-free", () => {
    expect(depcheck.scanEntryGraph()).toEqual([])
  })
})
