import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { checkPublicApiDocs } from "./check-public-api-docs.mjs"

const roots: string[] = []

function check(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "headcanon-api-docs-"))
  roots.push(root)
  const all = {
    "tsconfig.json": JSON.stringify({
      compilerOptions: { strict: true, module: "ESNext", noEmit: true },
    }),
    ...files,
  }
  for (const [path, source] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), source)
  }
  return checkPublicApiDocs({
    root,
    entries: [{ key: ".", source: join(root, "src/index.ts") }],
    tsconfig: join(root, "tsconfig.json"),
  })
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true })
})

describe("public API docs gate", () => {
  it("accepts a destructured parameter documented by position", () => {
    expect(
      check({
        "src/index.ts": `
/**
 * Greets someone.
 * @param options Who to greet.
 * @returns The greeting.
 */
export function greet({ name }: { name: string }): string {
  return name
}`,
      })
    ).toEqual({ failures: [], declarationCount: 1 })
  })

  it("rejects a destructured parameter with no @param", () => {
    expect(
      check({
        "src/index.ts": `
/**
 * Greets someone.
 * @returns The greeting.
 */
export function greet({ name }: { name: string }): string {
  return name
}`,
      }).failures
    ).toEqual(["src/index.ts:6 greet is missing @param for parameter 1"])
  })

  it("rejects missing JSDoc, a missing named @param, and a missing @returns", () => {
    expect(
      check({
        "src/index.ts": `
export const bare = 1
/** Adds. */
export function add(left: number, right: number) {
  return left + right
}`,
      }).failures.sort()
    ).toEqual([
      "src/index.ts:2 bare is missing public JSDoc",
      "src/index.ts:4 add is missing @param left",
      "src/index.ts:4 add is missing @param right",
      "src/index.ts:4 add is missing @returns",
    ])
  })

  it("follows re-exports from the entry and ignores modules no entry exports", () => {
    expect(
      check({
        "src/index.ts": 'export { inner } from "./inner"',
        "src/inner.ts": "export const inner = 1",
        "src/private.ts": "export const unexported = 1",
      }).failures
    ).toEqual(["src/inner.ts:1 inner is missing public JSDoc"])
  })
})
