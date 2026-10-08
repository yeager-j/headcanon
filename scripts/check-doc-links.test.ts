import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  checkDocLinks,
  checkEntryTable,
  docFiles,
  headingSlugs,
  markdownLinks,
  markdownPathMentions,
} from "./check-doc-links.mjs"

const roots: string[] = []

function tree(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "headcanon-doc-links-"))
  roots.push(root)

  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), contents)
  }

  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true })
})

describe("heading slugs", () => {
  it("lowercases, strips punctuation, and joins words with hyphens", () => {
    const slugs = headingSlugs(
      [
        "# Getting started",
        "## 1. Install the packages",
        "### Use `useSnapshotRefresh`, then [retry](x.md)!",
        "## Screen vs. Admit ##",
      ].join("\n")
    )

    expect([...slugs]).toEqual([
      "getting-started",
      "1-install-the-packages",
      "use-usesnapshotrefresh-then-retry",
      "screen-vs-admit",
    ])
  })

  it("numbers repeated headings and skips headings in fenced code", () => {
    const slugs = headingSlugs(
      ["## Setup", "```sh", "# .env.local", "```", "## Setup", "## Setup"].join(
        "\n"
      )
    )

    expect([...slugs]).toEqual(["setup", "setup-1", "setup-2"])
  })
})

describe("markdown links", () => {
  it("finds relative inline links and reference definitions with their lines", () => {
    const links = markdownLinks(
      [
        "See [Server setup](server-setup.md#bind-your-commands).",
        "",
        "[`README.md`](../README.md) and [top](#top).",
        "",
        "[guide]: ./react.md",
      ].join("\n")
    )

    expect(links).toEqual([
      { line: 1, target: "server-setup.md#bind-your-commands" },
      { line: 3, target: "../README.md" },
      { line: 3, target: "#top" },
      { line: 5, target: "./react.md" },
    ])
  })

  it("skips URL schemes, fenced code, and code spans", () => {
    const links = markdownLinks(
      [
        "[site](https://example.com/a.md) [mail](mailto:a@example.com)",
        "```md",
        "[fenced](missing.md)",
        "```",
        "`[span](missing.md)`",
      ].join("\n")
    )

    expect(links).toEqual([])
  })
})

describe("markdown path mentions", () => {
  it("finds .md paths with anchors and skips URLs", () => {
    const mentions = markdownPathMentions(
      [
        "/**",
        " * See docs/server-setup.md#bound-database-and-network-waits.",
        " * Also README.md, and https://example.com/docs/a.md.",
        " */",
      ].join("\n")
    )

    expect(mentions).toEqual([
      {
        line: 2,
        target: "docs/server-setup.md#bound-database-and-network-waits",
      },
      { line: 3, target: "README.md" },
    ])
  })
})

describe("doc links gate", () => {
  it("lists README, CONTRIBUTING, guides, and non-test sources", () => {
    const root = tree({
      "README.md": "",
      "docs/guide.md": "",
      "docs/notes.txt": "",
      "src/index.ts": "",
      "src/index.test.ts": "",
    })

    expect(docFiles(root)).toEqual([
      "README.md",
      "docs/guide.md",
      "src/index.ts",
    ])
  })

  it("accepts links and mentions whose files and headings exist", () => {
    const root = tree({
      "README.md":
        "# Top\n\nSee [the guide](docs/guide.md#set-up) and [top](#top).",
      "docs/guide.md": "## Set up\n\nBack to [the README](../README.md).",
      "src/index.ts": "// See docs/guide.md#set-up.",
    })

    expect(
      checkDocLinks({
        root,
        files: ["README.md", "docs/guide.md", "src/index.ts"],
      })
    ).toEqual({ failures: [], referenceCount: 4 })
  })

  it("rejects a missing file and a missing heading, with file and line", () => {
    const root = tree({
      "README.md": "# Top\n\n[API](docs/api.md)\n[gone](#gone)",
      "docs/guide.md": "## Set up",
      "src/index.ts": "/**\n * See docs/guide.md#old-heading.\n */",
    })

    expect(
      checkDocLinks({ root, files: ["README.md", "src/index.ts"] }).failures
    ).toEqual([
      "README.md:3 links to missing file docs/api.md",
      "README.md:4 links to missing heading #gone in README.md",
      "src/index.ts:2 links to missing heading #old-heading in docs/guide.md",
    ])
  })
})

describe("entry table gate", () => {
  const readme = [
    "# Package",
    "",
    "## Entry points",
    "",
    "| Entry | Use it in |",
    "| ----- | --------- |",
    "| `pkg` | Anywhere |",
    "| `pkg/server` | Servers |",
    "| `pkg/old` | Nowhere |",
    "| `pkg/server` | Servers |",
    "",
    "## Further reading",
    "",
    "| `pkg/later` | Not in the table section |",
  ].join("\n")

  it("accepts a table with one row per export key", () => {
    const validReadme = [
      "## Entry points",
      "",
      "| Entry | Use it in |",
      "| ----- | --------- |",
      "| `pkg` | Anywhere |",
      "| `pkg/server` | Servers |",
    ].join("\n")

    expect(
      checkEntryTable({
        readme: validReadme,
        packageName: "pkg",
        exportKeys: [".", "./server"],
      })
    ).toEqual([])
  })

  it("rejects missing, unknown, and repeated entries", () => {
    expect(
      checkEntryTable({
        readme,
        packageName: "pkg",
        exportKeys: [".", "./server", "./testing"],
      })
    ).toEqual([
      "README.md:9 lists pkg/old, which package.json#exports does not export",
      "README.md:10 lists pkg/server twice",
      'README.md:3 "Entry points" table is missing pkg/testing',
    ])
  })

  it("rejects a README with no entry table section", () => {
    expect(
      checkEntryTable({
        readme: "# Package",
        packageName: "pkg",
        exportKeys: ["."],
      })
    ).toEqual(['README.md has no "Entry points" section'])
  })
})
