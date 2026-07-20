// @ts-check

import { existsSync, readFileSync } from "node:fs"
import { builtinModules } from "node:module"
import { dirname, extname, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = fileURLToPath(new URL(".", import.meta.url))
const ENTRY = join(ROOT, "src/index.ts")
const CLIENT_ENTRIES = [ENTRY, join(ROOT, "src/react.ts")]
const BUILT_INS = new Set(
  builtinModules.flatMap((specifier) => [specifier, `node:${specifier}`])
)
const SERVER_DEPENDENCY_PREFIXES = [
  "@libsql/",
  "@neondatabase/",
  "@prisma/",
  "@vercel/postgres",
  "better-sqlite3",
  "drizzle-orm",
  "mongodb",
  "mysql2",
  "next/cache",
  "next/headers",
  "next/server",
  "pg",
  "postgres",
  "prisma",
  "server-only",
]
const IMPORT_PATTERNS = [
  /^[ \t]*(?:import|export)\b[^"';]*?\bfrom\s*["']([^"']+)["']/gm,
  /^[ \t]*import\s*["']([^"']+)["']/gm,
  /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g,
]

function blankComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (match) => " ".repeat(match.length))
}

function lineAt(source, index) {
  return source.slice(0, index).split("\n").length
}

function importSpecifiers(source) {
  const scanned = blankComments(source)
  const found = []

  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(scanned)) !== null) {
      found.push({ specifier: match[1], line: lineAt(scanned, match.index) })
    }
  }

  return found
}

function forbiddenSpecifier(specifier) {
  return (
    BUILT_INS.has(specifier) ||
    SERVER_DEPENDENCY_PREFIXES.some(
      (prefix) =>
        specifier === prefix ||
        specifier.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)
    )
  )
}

export function scanSource(file, source) {
  const violations = []
  const scanned = blankComments(source)

  if (/^[ \t]*["']use server["'];?/m.test(scanned)) {
    violations.push({ file, line: 1, rule: "server directive in client graph" })
  }

  for (const pattern of [/\bprocess\.env\b/g, /\bimport\.meta\.env\b/g]) {
    const match = pattern.exec(scanned)
    if (match) {
      violations.push({
        file,
        line: lineAt(scanned, match.index),
        rule: "environment access in client graph",
      })
    }
  }

  for (const { specifier, line } of importSpecifiers(source)) {
    if (specifier && forbiddenSpecifier(specifier)) {
      violations.push({
        file,
        line,
        specifier,
        rule: "server dependency in client graph",
      })
    }
  }

  return violations
}

function resolveRelativeImport(importer, specifier) {
  const target = resolve(dirname(importer), specifier)
  const candidates = extname(target)
    ? [target]
    : [
        `${target}.ts`,
        `${target}.tsx`,
        `${target}.js`,
        `${target}.mjs`,
        join(target, "index.ts"),
        join(target, "index.tsx"),
      ]

  return candidates.find(existsSync)
}

export function scanEntryGraph(entry = ENTRY) {
  const pending = [entry]
  const visited = new Set()
  const violations = []

  while (pending.length > 0) {
    const file = pending.pop()
    if (!file || visited.has(file)) continue

    visited.add(file)
    const source = readFileSync(file, "utf8")
    const displayPath = relative(ROOT, file).split("\\").join("/")
    violations.push(...scanSource(displayPath, source))

    for (const { specifier } of importSpecifiers(source)) {
      if (!specifier?.startsWith(".")) continue

      const target = resolveRelativeImport(file, specifier)
      if (!target) {
        violations.push({
          file: displayPath,
          line: 1,
          specifier,
          rule: "unresolved relative import in client graph",
        })
        continue
      }

      const targetPath = relative(ROOT, target).split("\\").join("/")
      if (/(^|\/)(server|[^/]+\.server)\b/.test(targetPath)) {
        violations.push({
          file: displayPath,
          line: 1,
          specifier,
          rule: "server module in client graph",
        })
      }
      pending.push(target)
    }
  }

  return violations
}

export function scanClientEntries(entries = CLIENT_ENTRIES) {
  return entries.flatMap((entry) => scanEntryGraph(entry))
}

function run() {
  const violations = scanClientEntries()

  if (violations.length === 0) {
    console.log("✓ headcanon client entries are bundle-safe.")
    return
  }

  console.error("✖ headcanon client entry dependency violations:\n")
  for (const violation of violations) {
    console.error(
      `  ${violation.file}:${violation.line}  ${violation.specifier ?? violation.rule}\n    └─ ${violation.rule}`
    )
  }
  process.exitCode = 1
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  run()
}
