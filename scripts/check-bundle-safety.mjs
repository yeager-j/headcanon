// @ts-check

import { readFileSync } from "node:fs"
import { builtinModules } from "node:module"
import { relative } from "node:path"
import { pathToFileURL } from "node:url"
import ts from "typescript"

import { compilerOptions } from "./compiler-options.mjs"
import { packageEntries, ROOT } from "./package-entries.mjs"

/**
 * Export keys that run only on a server or in a test runner. Every other
 * export ships to browsers and its import graph is walked, so a new export is
 * checked until someone decides here that it is server-only. A key also covers
 * its subpaths: `./testing` covers `./testing/react`.
 */
const SERVER_ONLY_EXPORTS = [
  "./ably/server",
  "./drizzle",
  "./drizzle-schema",
  "./next/server",
  "./testing",
]

/** The export whose graph must also stay free of React and Next. */
const SHARED_EXPORT = "."

/**
 * Exports of test doubles. Their graphs must import no test framework, so the
 * doubles load in any runner and in an application's server code. The exact
 * key only: `./testing/contracts` and `./testing/react` publish vitest suites.
 */
const TEST_DOUBLE_EXPORTS = ["./testing"]

/** Test frameworks a test-double graph may not import, subpaths included. */
const TEST_FRAMEWORK_PACKAGES = ["vitest", "@testing-library"]

/**
 * Third-party packages a client graph may import. The walk does not descend
 * into packages: each one is vetted once, here, as browser-safe for the
 * specifiers listed. Descending would mean reimplementing bundler resolution
 * (`exports` conditions, `browser` fields) and would flag the Node build of a
 * package that also ships a browser build. Listing what is allowed, instead
 * of what is forbidden, makes any new dependency in a client graph fail until
 * someone vets it. A listed package also allows its subpaths.
 */
const CLIENT_PACKAGES = [
  "@standard-schema/spec",
  "canonicalize",
  "next/navigation",
  "react",
  "serializable-result",
]
const FRAMEWORK_PACKAGES = ["next", "react", "react-dom"]
const BUILT_INS = new Set(
  builtinModules.flatMap((specifier) => [specifier, `node:${specifier}`])
)
const RESOLUTION_OPTIONS = compilerOptions()
const IMPORT_PATTERNS = [
  /^[ \t]*(?:import|export)\b[^"';]*?\bfrom\s*["']([^"']+)["']/gm,
  /^[ \t]*import\s*["']([^"']+)["']/gm,
  /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g,
]

/**
 * @typedef {object} Violation
 * @property {string} file Root-relative path of the offending file.
 * @property {number} line One-based line of the offending code.
 * @property {string} rule The rule the file breaks.
 * @property {string} [specifier] The offending import specifier, if any.
 */

/** @param {string} source */
function blankComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (match) => " ".repeat(match.length))
}

/**
 * @param {string} source
 * @param {number} index
 */
function lineAt(source, index) {
  return source.slice(0, index).split("\n").length
}

/**
 * @param {string} root
 * @param {string} file
 */
function reportPath(root, file) {
  return relative(root, file).split("\\").join("/")
}

/**
 * @param {string} source
 * @returns {Array<{ specifier: string, line: number }>}
 */
function importSpecifiers(source) {
  const scanned = blankComments(source)
  const found = []

  for (const pattern of IMPORT_PATTERNS) {
    for (const match of scanned.matchAll(pattern)) {
      const specifier = match[1]
      if (!specifier) continue
      found.push({ specifier, line: lineAt(scanned, match.index) })
    }
  }

  return found
}

/**
 * @param {string} specifier
 * @param {string[]} packages
 */
function inPackages(specifier, packages) {
  return packages.some(
    (name) => specifier === name || specifier.startsWith(`${name}/`)
  )
}

/**
 * @param {string} key
 * @param {string} exportKey
 */
function covers(key, exportKey) {
  return exportKey === key || exportKey.startsWith(`${key}/`)
}

/**
 * Selects the entries whose graphs ship to browsers: every export not marked
 * server-only.
 *
 * @param {import("./package-entries.mjs").PackageEntry[]} [entries] The package's entries.
 * @returns {import("./package-entries.mjs").PackageEntry[]} The client entries.
 */
export function clientEntries(entries = packageEntries()) {
  return entries.filter(
    ({ key }) => !SERVER_ONLY_EXPORTS.some((server) => covers(server, key))
  )
}

/**
 * Selects the entries that publish test doubles.
 *
 * @param {import("./package-entries.mjs").PackageEntry[]} [entries] The package's entries.
 * @returns {import("./package-entries.mjs").PackageEntry[]} The test-double entries.
 */
export function testDoubleEntries(entries = packageEntries()) {
  return entries.filter(({ key }) => TEST_DOUBLE_EXPORTS.includes(key))
}

/**
 * Checks one file's own source against the client-graph rules.
 *
 * @param {string} file Root-relative path, used in reports.
 * @param {string} source The file's source text.
 * @param {boolean} [frameworkFree] Whether React and Next are also forbidden.
 * @returns {Violation[]} The rules the file breaks.
 */
export function scanSource(file, source, frameworkFree = false) {
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
    if (specifier.startsWith(".")) continue

    if (BUILT_INS.has(specifier)) {
      violations.push({
        file,
        line,
        specifier,
        rule: "Node built-in in client graph",
      })
    } else if (frameworkFree && inPackages(specifier, FRAMEWORK_PACKAGES)) {
      violations.push({
        file,
        line,
        specifier,
        rule: "framework dependency in shared graph",
      })
    } else if (!inPackages(specifier, CLIENT_PACKAGES)) {
      violations.push({
        file,
        line,
        specifier,
        rule: "unvetted package in client graph",
      })
    }
  }

  return violations
}

/**
 * Resolves a relative import exactly as the build does.
 *
 * @param {string} importer Absolute path of the importing file.
 * @param {string} specifier The relative specifier.
 * @returns {string | undefined} The resolved source file, if any.
 */
function resolveRelativeImport(importer, specifier) {
  // Under Node16/NodeNext the importer's own format (ESM or CommonJS) picks
  // the resolution rules; without it TypeScript falls back to CommonJS.
  const mode = ts.getImpliedNodeFormatForFile(
    importer,
    undefined,
    ts.sys,
    RESOLUTION_OPTIONS
  )
  return ts.resolveModuleName(
    specifier,
    importer,
    RESOLUTION_OPTIONS,
    ts.sys,
    undefined,
    undefined,
    mode
  ).resolvedModule?.resolvedFileName
}

/**
 * @typedef {object} GraphCheck
 * @property {(file: string, source: string) => Violation[]} file Checks one
 *   reached file's own source.
 * @property {(file: string, line: number, specifier: string, target: string) => Violation[]} [edge]
 *   Checks one resolved relative import.
 */

/**
 * Walks every relative import reachable from one entry file and applies a
 * check to each file and import it reaches.
 *
 * @param {string} entry Absolute path of the entry's source file.
 * @param {string} root The root that report paths are relative to.
 * @param {GraphCheck} check The rules for this graph.
 * @returns {Violation[]} Every rule broken in the graph.
 */
function walkEntryGraph(entry, root, check) {
  const pending = [entry]
  const visited = new Set()
  const violations = []

  while (pending.length > 0) {
    const file = pending.pop()
    if (!file || visited.has(file)) continue

    visited.add(file)
    const source = readFileSync(file, "utf8")
    const displayPath = reportPath(root, file)
    violations.push(...check.file(displayPath, source))

    for (const { specifier, line } of importSpecifiers(source)) {
      if (!specifier.startsWith(".")) continue

      const target = resolveRelativeImport(file, specifier)
      if (!target) {
        violations.push({
          file: displayPath,
          line,
          specifier,
          rule: "unresolved relative import",
        })
        continue
      }

      const targetPath = reportPath(root, target)
      violations.push(
        ...(check.edge?.(displayPath, line, specifier, targetPath) ?? [])
      )
      pending.push(target)
    }
  }

  return violations
}

/**
 * Walks every relative import reachable from one client entry file and checks
 * each file it reaches.
 *
 * @param {string} entry Absolute path of the entry's source file.
 * @param {{ frameworkFree?: boolean, root?: string }} [options] Whether React
 *   and Next are forbidden in this graph, and the root that report paths are
 *   relative to.
 * @returns {Violation[]} Every rule broken in the graph.
 */
export function scanEntryGraph(
  entry,
  { frameworkFree = false, root = ROOT } = {}
) {
  return walkEntryGraph(entry, root, {
    file: (file, source) => scanSource(file, source, frameworkFree),
    edge: (file, line, specifier, target) =>
      /(^|\/)(server|[^/]+\.server)\b/.test(target)
        ? [{ file, line, specifier, rule: "server module in client graph" }]
        : [],
  })
}

/**
 * Walks a test-double entry's graph and reports every test-framework import.
 *
 * @param {string} entry Absolute path of the entry's source file.
 * @param {string} [root] The root that report paths are relative to.
 * @returns {Violation[]} Every test-framework import in the graph.
 */
export function scanTestDoubleGraph(entry, root = ROOT) {
  return walkEntryGraph(entry, root, {
    file: (file, source) =>
      importSpecifiers(source)
        .filter(({ specifier }) =>
          inPackages(specifier, TEST_FRAMEWORK_PACKAGES)
        )
        .map(({ specifier, line }) => ({
          file,
          line,
          specifier,
          rule: "test framework in test-double graph",
        })),
  })
}

/**
 * Checks the graph of every client entry. A file reached from several entries
 * is reported once per distinct violation.
 *
 * @param {import("./package-entries.mjs").PackageEntry[]} [entries] The client
 *   entries to walk.
 * @param {string} [root] The root that report paths are relative to.
 * @returns {Violation[]} Every rule broken in any client graph.
 */
export function scanClientEntries(entries = clientEntries(), root = ROOT) {
  const unique = new Map()
  for (const { key, source } of entries) {
    const frameworkFree = key === SHARED_EXPORT
    for (const violation of scanEntryGraph(source, { frameworkFree, root })) {
      const id = [
        violation.file,
        violation.line,
        violation.rule,
        violation.specifier,
      ].join("\0")
      if (!unique.has(id)) unique.set(id, violation)
    }
  }
  return [...unique.values()]
}

function run() {
  const entries = clientEntries()
  const doubles = testDoubleEntries()
  const violations = [
    ...scanClientEntries(entries),
    ...doubles.flatMap(({ source }) => scanTestDoubleGraph(source)),
  ]

  if (violations.length === 0) {
    console.log(
      `✓ ${entries.length} client entries are bundle-safe: ${entries.map(({ key }) => key).join(", ")}`
    )
    console.log(
      `✓ ${doubles.length} test-double entry imports no test framework: ${doubles.map(({ key }) => key).join(", ")}`
    )
    return
  }

  console.error("✖ headcanon entry dependency violations:\n")
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
