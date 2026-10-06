// @ts-check

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

/** The repo root, which is also the package root. */
export const ROOT = fileURLToPath(new URL("..", import.meta.url))

/**
 * @typedef {object} PackageEntry
 * @property {string} key The export key, such as `"."` or `"./react"`.
 * @property {string} source The absolute path of the entry's `src/*.ts` file.
 */

/**
 * Lists the package's public entry points from `package.json#exports`,
 * mapping each export's `./dist/*.js` default target to its `src/*.ts` source.
 *
 * @param {string} [root] The package root that holds `package.json` and `src/`.
 * @returns {PackageEntry[]} One entry per export key, in manifest order.
 * @throws Error when an export has no `./dist/*.js` default target, or its
 *   `src/*.ts` source does not exist.
 */
export function packageEntries(root = ROOT) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))

  return Object.entries(manifest.exports ?? {}).map(([key, target]) => {
    const built = typeof target === "string" ? target : target?.default
    const match = /^\.\/dist\/(.+)\.js$/.exec(built ?? "")
    if (!match) {
      throw new Error(
        `package.json#exports["${key}"] must have a ./dist/*.js default target.`
      )
    }

    const source = join(root, "src", `${match[1]}.ts`)
    if (!existsSync(source)) {
      throw new Error(
        `package.json#exports["${key}"] has no source file src/${match[1]}.ts.`
      )
    }
    return { key, source }
  })
}
