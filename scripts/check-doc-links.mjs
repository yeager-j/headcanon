// @ts-check

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { pathToFileURL } from "node:url"

import { packageEntries, ROOT } from "./package-entries.mjs"

/** The README heading whose table lists every `package.json#exports` key. */
export const ENTRY_TABLE_HEADING = "Entry points"

/**
 * @typedef {object} DocReference
 * @property {number} line The 1-based line of the reference in its file.
 * @property {string} target The referenced path and optional `#anchor`, as
 *   written.
 */

/**
 * Lists the files whose links the gate checks: `README.md`,
 * `CONTRIBUTING.md`, `docs/**\/*.md`, and the non-test `src/**\/*.ts` files.
 *
 * @param {string} root The repo root.
 * @returns {string[]} Paths relative to `root`, with `/` separators.
 */
export function docFiles(root) {
  const markdown = ["README.md", "CONTRIBUTING.md"].filter((file) =>
    existsSync(join(root, file))
  )
  const guides = filesUnder(root, "docs").filter((file) => file.endsWith(".md"))
  const sources = filesUnder(root, "src").filter(
    (file) => file.endsWith(".ts") && !file.endsWith(".test.ts")
  )

  return [...markdown, ...guides, ...sources]
}

/**
 * @param {string} root
 * @param {string} directory
 * @returns {string[]}
 */
function filesUnder(root, directory) {
  if (!existsSync(join(root, directory))) return []

  return readdirSync(join(root, directory), { recursive: true })
    .map((file) => join(directory, String(file)).split("\\").join("/"))
    .sort()
}

/**
 * Lists the GitHub anchor slugs of a Markdown file's ATX (`#`) headings.
 * A slug is the heading text in lowercase, with punctuation other than `-`
 * and `_` removed and each space replaced by `-`. A repeated slug gets a
 * `-1`, `-2`, ... suffix, as on GitHub. Headings in fenced code blocks do not
 * count.
 *
 * @param {string} markdown The file's contents.
 * @returns {Set<string>} Every anchor a link into the file can use.
 */
export function headingSlugs(markdown) {
  const slugs = new Set()
  /** @type {Map<string, number>} */
  const seen = new Map()

  for (const line of maskFences(markdown).split("\n")) {
    const heading = /^ {0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(line)
    if (!heading?.[1]) continue

    const slug = slugify(heading[1])
    const count = seen.get(slug) ?? 0

    seen.set(slug, count + 1)
    slugs.add(count === 0 ? slug : `${slug}-${count}`)
  }

  return slugs
}

/**
 * @param {string} headingText
 * @returns {string}
 */
function slugify(headingText) {
  const visibleText = headingText
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")

  return visibleText
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-")
}

/**
 * Finds the relative link targets in a Markdown file: inline links
 * `[text](target)` and reference definitions `[label]: target`. Links in
 * fenced code blocks or code spans, and targets with a URL scheme such as
 * `https:` or `mailto:`, are skipped.
 *
 * @param {string} markdown The file's contents.
 * @returns {DocReference[]} One reference per link, in file order.
 */
export function markdownLinks(markdown) {
  const text = maskCodeSpans(maskFences(markdown))
  const inline = /\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g
  const definition = /^ {0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/gm
  const matches = [...text.matchAll(inline), ...text.matchAll(definition)]

  return matches
    .filter((match) => !/^[a-z][a-z0-9+.-]*:/i.test(match[1] ?? ""))
    .map((match) => ({
      line: lineAt(text, match.index),
      target: match[1] ?? "",
    }))
    .sort((left, right) => left.line - right.line)
}

/**
 * Finds the `.md` paths that a source file mentions, such as
 * `docs/server-setup.md#bound-database-and-network-waits` in a JSDoc comment.
 * The gate resolves these from the repo root.
 *
 * @param {string} source The file's contents.
 * @returns {DocReference[]} One reference per mention, in file order.
 */
export function markdownPathMentions(source) {
  const mention = /(?<![\w./:-])(?:[\w.-]+\/)*[\w.-]+\.md(?:#[\w-]*)?(?![\w/])/g

  return [...source.matchAll(mention)].map((match) => ({
    line: lineAt(source, match.index),
    target: match[0],
  }))
}

/**
 * Replaces each line of a fenced code block with an empty line, so that
 * nothing in it reads as a heading or link and line numbers do not move.
 *
 * @param {string} markdown
 * @returns {string}
 */
function maskFences(markdown) {
  /** @type {string | undefined} */
  let openFence

  return markdown
    .split("\n")
    .map((line) => {
      const fence = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
      if (openFence === undefined) {
        if (!fence) return line

        openFence = fence
        return ""
      }

      const closes =
        fence !== undefined &&
        fence[0] === openFence[0] &&
        fence.length >= openFence.length &&
        line.trim() === fence
      if (closes) openFence = undefined

      return ""
    })
    .join("\n")
}

/**
 * Replaces each code span with spaces of the same length, keeping newlines.
 *
 * @param {string} markdown
 * @returns {string}
 */
function maskCodeSpans(markdown) {
  return markdown.replace(/(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, (span) =>
    span.replace(/[^\n]/g, " ")
  )
}

/**
 * @param {string} text
 * @param {number} index
 * @returns {number}
 */
function lineAt(text, index) {
  return text.slice(0, index).split("\n").length
}

/**
 * Checks that every relative link in the doc files names a file that exists,
 * and that every `#anchor` into a Markdown file names one of its headings.
 * Markdown files are checked with `markdownLinks`, resolved from the linking
 * file. Source files are checked with `markdownPathMentions`, resolved from
 * `root`.
 *
 * @param {object} [options] What to check.
 * @param {string} [options.root] The repo root; reports are relative to it.
 * @param {string[]} [options.files] The files to check, relative to `root`.
 * @returns {{ failures: string[], referenceCount: number }} One
 *   `file:line message` per broken reference, and how many were checked.
 */
export function checkDocLinks({ root = ROOT, files = docFiles(root) } = {}) {
  /** @type {Map<string, Set<string>>} */
  const slugCache = new Map()
  /** @type {string[]} */
  const failures = []
  let referenceCount = 0

  /** @param {string} path */
  function slugsOf(path) {
    const cached = slugCache.get(path)
    if (cached) return cached

    const slugs = headingSlugs(readFileSync(path, "utf8"))
    slugCache.set(path, slugs)
    return slugs
  }

  for (const file of files) {
    const contents = readFileSync(join(root, file), "utf8")
    const isMarkdown = file.endsWith(".md")
    const references = isMarkdown
      ? markdownLinks(contents)
      : markdownPathMentions(contents)
    const base = isMarkdown ? dirname(join(root, file)) : root

    for (const { line, target } of references) {
      referenceCount += 1

      const [path = "", anchor] = target.split("#")
      const targetPath = path
        ? join(base, decodeURIComponent(path))
        : join(root, file)
      const shownTarget = path ? relative(root, targetPath) : file

      if (!existsSync(targetPath)) {
        failures.push(`${file}:${line} links to missing file ${shownTarget}`)
        continue
      }

      const checksAnchor = anchor !== undefined && targetPath.endsWith(".md")
      if (checksAnchor && !slugsOf(targetPath).has(anchor)) {
        failures.push(
          `${file}:${line} links to missing heading #${anchor} in ${shownTarget}`
        )
      }
    }
  }

  return { failures, referenceCount }
}

/**
 * Checks that the README's "Entry points" table has one row per
 * `package.json#exports` key and no other rows. A row names its entry as a
 * code span in the first cell, such as `` `headcanon/server` ``.
 *
 * @param {object} options What to check.
 * @param {string} options.readme The README's contents.
 * @param {string} options.packageName The package name, such as `headcanon`.
 * @param {string[]} options.exportKeys The `package.json#exports` keys, such
 *   as `"."` and `"./server"`.
 * @returns {string[]} One `README.md:line message` per missing, unknown, or
 *   repeated row.
 */
export function checkEntryTable({ readme, packageName, exportKeys }) {
  const rows = entryTableRows(readme)
  if (rows === undefined) {
    return [`README.md has no "${ENTRY_TABLE_HEADING}" section`]
  }

  const expected = exportKeys.map((key) =>
    key === "." ? packageName : `${packageName}/${key.replace(/^\.\//, "")}`
  )
  const listed = new Set()
  /** @type {string[]} */
  const failures = []

  for (const { line, entry } of rows.entries) {
    if (listed.has(entry)) {
      failures.push(`README.md:${line} lists ${entry} twice`)
    } else if (!expected.includes(entry)) {
      failures.push(
        `README.md:${line} lists ${entry}, which package.json#exports does not export`
      )
    }

    listed.add(entry)
  }

  for (const entry of expected.filter((name) => !listed.has(name))) {
    failures.push(
      `README.md:${rows.headingLine} "${ENTRY_TABLE_HEADING}" table is missing ${entry}`
    )
  }

  return failures
}

/**
 * @param {string} readme
 * @returns {{ headingLine: number, entries: { line: number, entry: string }[] } | undefined}
 */
function entryTableRows(readme) {
  const lines = maskFences(readme).split("\n")
  const headingIndex = lines.findIndex((line) =>
    new RegExp(`^#{1,6}\\s+${ENTRY_TABLE_HEADING}\\s*$`).test(line)
  )
  if (headingIndex === -1) return undefined

  const sectionEnd = lines.findIndex(
    (line, index) => index > headingIndex && /^#{1,6}\s/.test(line)
  )
  const section = lines.slice(
    headingIndex + 1,
    sectionEnd === -1 ? undefined : sectionEnd
  )
  const entries = section.flatMap((line, offset) => {
    const entry = /^\|\s*`([^`]+)`\s*\|/.exec(line)?.[1]
    return entry ? [{ line: headingIndex + 2 + offset, entry }] : []
  })

  return { headingLine: headingIndex + 1, entries }
}

function run() {
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
  const exportKeys = packageEntries().map(({ key }) => key)
  const files = docFiles(ROOT)
  const links = checkDocLinks({ root: ROOT, files })
  const tableFailures = checkEntryTable({
    readme: readFileSync(join(ROOT, "README.md"), "utf8"),
    packageName: manifest.name,
    exportKeys,
  })
  const failures = [...links.failures, ...tableFailures]

  if (failures.length > 0) {
    console.error(failures.join("\n"))
    process.exitCode = 1
  } else {
    console.log(
      `✓ ${links.referenceCount} doc links across ${files.length} files resolve, and the README lists all ${exportKeys.length} entries.`
    )
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  run()
}
