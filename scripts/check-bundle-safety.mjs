// @ts-check

import { existsSync, readFileSync } from "node:fs"
import { builtinModules } from "node:module"
import { dirname, extname, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"

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
// `./handler.server` has no source extension, so it still gets candidates.
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs"]
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
 * @param {string} source
 * @returns {Array<{ specifier: string | undefined, line: number }>}
 */
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
    if (!specifier || specifier.startsWith(".")) continue

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
 * @param {string} importer
 * @param {string} specifier
 */
function resolveRelativeImport(importer, specifier) {
  const target = resolve(dirname(importer), specifier)
  const candidates = SOURCE_EXTENSIONS.includes(extname(target))
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

/**
 * Walks every relative import reachable from one entry file and checks each
 * file it reaches.
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
  const pending = [entry]
  const visited = new Set()
  const violations = []

  while (pending.length > 0) {
    const file = pending.pop()
    if (!file || visited.has(file)) continue

    visited.add(file)
    const source = readFileSync(file, "utf8")
    const displayPath = relative(root, file).split("\\").join("/")
    violations.push(...scanSource(displayPath, source, frameworkFree))

    for (const { specifier, line } of importSpecifiers(source)) {
      if (!specifier?.startsWith(".")) continue

      const target = resolveRelativeImport(file, specifier)
      if (!target) {
        violations.push({
          file: displayPath,
          line,
          specifier,
          rule: "unresolved relative import in client graph",
        })
        continue
      }

      const targetPath = relative(root, target).split("\\").join("/")
      if (/(^|\/)(server|[^/]+\.server)\b/.test(targetPath)) {
        violations.push({
          file: displayPath,
          line,
          specifier,
          rule: "server module in client graph",
        })
      }
      pending.push(target)
    }
  }

  return violations
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
  const violations = scanClientEntries(entries)

  if (violations.length === 0) {
    console.log(
      `✓ ${entries.length} client entries are bundle-safe: ${entries.map(({ key }) => key).join(", ")}`
    )
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
