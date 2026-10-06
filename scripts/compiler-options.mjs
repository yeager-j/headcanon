// @ts-check

import { join } from "node:path"
import ts from "typescript"

import { ROOT } from "./package-entries.mjs"

/**
 * Reads a tsconfig's compiler options, by default the build's.
 *
 * @param {string} [tsconfig] The tsconfig to read.
 * @returns {ts.CompilerOptions} Its parsed compiler options.
 * @throws Error when the tsconfig cannot be read.
 */
export function compilerOptions(tsconfig = join(ROOT, "tsconfig.build.json")) {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    tsconfig,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic(diagnostic) {
        throw new Error(
          ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
        )
      },
    }
  )
  if (!parsed) throw new Error(`Cannot read ${tsconfig}.`)
  return parsed.options
}
