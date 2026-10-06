import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { packageEntries, ROOT } from "./package-entries.mjs"

const roots: string[] = []

function packageWith(exports: unknown, sources: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "headcanon-entries-"))
  roots.push(root)
  writeFileSync(join(root, "package.json"), JSON.stringify({ exports }))
  for (const source of sources) {
    mkdirSync(join(root, "src", source, ".."), { recursive: true })
    writeFileSync(join(root, "src", source), "")
  }
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true })
})

describe("package entries", () => {
  it("maps each export's built target back to its source file", () => {
    const root = packageWith(
      {
        ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
        "./schema": "./dist/receipt-table.js",
        "./testing/react": { default: "./dist/testing/react.js" },
      },
      ["index.ts", "receipt-table.ts", "testing/react.ts"]
    )

    expect(packageEntries(root)).toEqual([
      { key: ".", source: join(root, "src/index.ts") },
      { key: "./schema", source: join(root, "src/receipt-table.ts") },
      { key: "./testing/react", source: join(root, "src/testing/react.ts") },
    ])
  })

  it("rejects an export whose target is not a built module", () => {
    const root = packageWith({ "./package.json": "./package.json" })

    expect(() => packageEntries(root)).toThrow(/"\.\/package\.json"/)
  })

  it("rejects an export with no source file", () => {
    const root = packageWith({ "./gone": "./dist/gone.js" })

    expect(() => packageEntries(root)).toThrow(/src\/gone\.ts/)
  })

  it("reads the real manifest, renamed entries included", () => {
    expect(packageEntries()).toContainEqual({
      key: "./drizzle-schema",
      source: join(ROOT, "src/drizzle/schema.ts"),
    })
  })
})
