import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  clientEntries,
  scanClientEntries,
  scanEntryGraph,
  scanSource,
} from "./check-bundle-safety.mjs"

const roots: string[] = []

function tree(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "headcanon-bundle-safety-"))
  roots.push(root)
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), source)
  }
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true })
})

describe("client-graph source rules", () => {
  it.each([
    ['import { createHash } from "node:crypto"', "node:crypto"],
    ['import { readFileSync } from "fs"', "fs"],
  ])("rejects a Node built-in", (source, specifier) => {
    expect(scanSource("src/index.ts", source)).toEqual([
      expect.objectContaining({
        file: "src/index.ts",
        specifier,
        rule: "Node built-in in client graph",
      }),
    ])
  })

  it.each([
    [
      'import { db } from "@neondatabase/serverless"',
      "@neondatabase/serverless",
    ],
    ['import "server-only"', "server-only"],
    ['export { run } from "next/server"', "next/server"],
    ['const jwt = await import("jsonwebtoken")', "jsonwebtoken"],
  ])("rejects a package nobody vetted for browsers", (source, specifier) => {
    expect(scanSource("src/index.ts", source)).toEqual([
      expect.objectContaining({
        file: "src/index.ts",
        specifier,
        rule: "unvetted package in client graph",
      }),
    ])
  })

  it.each([
    'import { useMemo } from "react"',
    'import { jsx } from "react/jsx-runtime"',
    'import { useRouter } from "next/navigation"',
    'import { ok } from "serializable-result"',
    'import { axisId } from "./revisions"',
  ])("accepts a vetted package or a relative import: %s", (source) => {
    expect(scanSource("src/react.ts", source)).toEqual([])
  })

  it("rejects server directives and secret-bearing environment access", () => {
    expect(
      scanSource(
        "src/server-handler.ts",
        `'use server'\nconst secret = process.env.AUTH_SECRET`
      )
    ).toEqual([
      expect.objectContaining({ rule: "server directive in client graph" }),
      expect.objectContaining({ rule: "environment access in client graph" }),
    ])
  })

  it("ignores imports inside comments", () => {
    expect(
      scanSource("src/index.ts", '// import { x } from "node:crypto"')
    ).toEqual([])
  })

  it.each([
    ['import type { ReactNode } from "react"', "react"],
    [
      'export type { AppRouterInstance } from "next/navigation"',
      "next/navigation",
    ],
  ])(
    "rejects a client framework dependency from the shared graph",
    (source, specifier) => {
      expect(scanSource("src/index.ts", source, true)).toEqual([
        expect.objectContaining({
          file: "src/index.ts",
          specifier,
          rule: "framework dependency in shared graph",
        }),
      ])
    }
  )
})

describe("client-graph walk", () => {
  it("reports a violation in a file reached only through imports", () => {
    const root = tree({
      "src/entry.ts": 'export { a } from "./a"',
      "src/a.ts": 'export { b } from "./nested/b"',
      "src/nested/b.ts": 'import { createHash } from "node:crypto"',
    })

    expect(scanEntryGraph(join(root, "src/entry.ts"), { root })).toEqual([
      expect.objectContaining({
        file: "src/nested/b.ts",
        specifier: "node:crypto",
        rule: "Node built-in in client graph",
      }),
    ])
  })

  it.each(["./server", "./next/server", "./handler.server"])(
    "rejects a server module reached by a relative import: %s",
    (specifier) => {
      const target = specifier.replace("./", "src/") + ".ts"
      const root = tree({
        "src/entry.ts": `\nimport { run } from "${specifier}"`,
        [target]: "export const run = 1",
      })

      expect(scanEntryGraph(join(root, "src/entry.ts"), { root })).toEqual([
        expect.objectContaining({
          file: "src/entry.ts",
          line: 2,
          specifier,
          rule: "server module in client graph",
        }),
      ])
    }
  )

  it("rejects a relative import that resolves to no file", () => {
    const root = tree({ "src/entry.ts": 'import { a } from "./missing"' })

    expect(scanEntryGraph(join(root, "src/entry.ts"), { root })).toEqual([
      expect.objectContaining({
        specifier: "./missing",
        rule: "unresolved relative import in client graph",
      }),
    ])
  })

  it("forbids React and Next in the shared graph only", () => {
    const root = tree({
      "src/index.ts": 'export { a } from "./a"',
      "src/react.ts": 'export { a } from "./a"',
      "src/a.ts": 'import { useMemo } from "react"',
    })
    const entries = [
      { key: ".", source: join(root, "src/index.ts") },
      { key: "./react", source: join(root, "src/react.ts") },
    ]

    expect(scanClientEntries(entries.slice(1), root)).toEqual([])
    expect(scanClientEntries(entries, root)).toEqual([
      expect.objectContaining({
        file: "src/a.ts",
        rule: "framework dependency in shared graph",
      }),
    ])
  })

  it("reports a file shared by several entries once and survives cycles", () => {
    const root = tree({
      "src/one.ts": 'export { shared } from "./shared"',
      "src/two.ts": 'export { shared } from "./shared"',
      "src/shared.ts":
        'import "node:fs"\nexport { one } from "./one"\nexport const shared = 1',
    })
    const entries = [
      { key: "./one", source: join(root, "src/one.ts") },
      { key: "./two", source: join(root, "src/two.ts") },
    ]

    expect(scanClientEntries(entries, root)).toEqual([
      expect.objectContaining({ file: "src/shared.ts", specifier: "node:fs" }),
    ])
  })
})

describe("client entry selection", () => {
  const entry = (key: string) => ({ key, source: `/src/${key}.ts` })

  it("treats every export not marked server-only as a client entry", () => {
    const keys = [
      ".",
      "./ably/channels",
      "./ably/client",
      "./ably/server",
      "./drizzle",
      "./drizzle-schema",
      "./next/client",
      "./next/server",
      "./react",
      "./testing",
      "./testing/react",
      "./brand-new",
    ]

    expect(clientEntries(keys.map(entry)).map(({ key }) => key)).toEqual([
      ".",
      "./ably/channels",
      "./ably/client",
      "./next/client",
      "./react",
      "./brand-new",
    ])
  })

  it("walks the package's browser entries, Ably included", () => {
    expect(clientEntries().map(({ key }) => key)).toEqual(
      expect.arrayContaining([
        ".",
        "./ably/channels",
        "./ably/client",
        "./next/client",
        "./react",
      ])
    )
  })

  it("keeps the real client entry graphs bundle-safe", () => {
    expect(scanClientEntries()).toEqual([])
  })
})
