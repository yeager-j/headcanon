// @ts-check

import { join, relative } from "node:path"
import { pathToFileURL } from "node:url"
import ts from "typescript"

import { compilerOptions } from "./compiler-options.mjs"
import { packageEntries, ROOT } from "./package-entries.mjs"

/**
 * Checks that every declaration exported from a public entry has JSDoc, and
 * that every exported callable documents each parameter and its return. A
 * destructured parameter is documented by the `@param` tag at its position.
 *
 * @param {object} [options] What to check.
 * @param {import("./package-entries.mjs").PackageEntry[]} [options.entries]
 *   The public entries; the walk starts from these and follows their exports.
 * @param {string} [options.root] The package root; only declarations under
 *   its `src/` are checked, and reports are relative to it.
 * @param {string} [options.tsconfig] The tsconfig whose compiler options the
 *   check uses.
 * @returns {{ failures: string[], declarationCount: number }} One message per
 *   missing piece of documentation, and how many declarations were checked.
 * @throws Error when an entry's source is not a module.
 */
export function checkPublicApiDocs({
  entries = packageEntries(),
  root = ROOT,
  tsconfig = join(root, "tsconfig.build.json"),
} = {}) {
  const sourceRoot = join(root, "src")
  const program = ts.createProgram(
    entries.map(({ source }) => source),
    compilerOptions(tsconfig)
  )
  const checker = program.getTypeChecker()
  /** @type {string[]} */
  const failures = []
  const visited = new Set()

  /**
   * @param {ts.Declaration} declaration
   * @param {string} message
   */
  function report(declaration, message) {
    const sourceFile = declaration.getSourceFile()
    const position = sourceFile.getLineAndCharacterOfPosition(
      declaration.getStart(sourceFile)
    )
    failures.push(
      `${relative(root, sourceFile.fileName)}:${position.line + 1} ${message}`
    )
  }

  /**
   * @param {ts.Symbol} symbol
   * @param {ts.Declaration} declaration
   */
  function checkCallable(symbol, declaration) {
    const signatures = checker
      .getTypeAtLocation(declaration)
      .getCallSignatures()
    if (signatures.length === 0) return

    const tags = ts.getJSDocTags(declaration)
    const paramTags = tags.filter(ts.isJSDocParameterTag)
    const paramNames = new Set(paramTags.map((tag) => tag.name.getText()))
    for (const signature of signatures) {
      signature.parameters.forEach((parameter, index) => {
        const parameterDeclaration = parameter.valueDeclaration
        const destructured =
          parameterDeclaration !== undefined &&
          ts.isParameter(parameterDeclaration) &&
          !ts.isIdentifier(parameterDeclaration.name)
        if (destructured) {
          if (index >= paramTags.length) {
            report(
              declaration,
              `${symbol.name} is missing @param for parameter ${index + 1}`
            )
          }
        } else if (!paramNames.has(parameter.getName())) {
          report(
            declaration,
            `${symbol.name} is missing @param ${parameter.getName()}`
          )
        }
      })
    }
    if (!tags.some((tag) => tag.tagName.text === "returns")) {
      report(declaration, `${symbol.name} is missing @returns`)
    }
  }

  for (const { source } of entries) {
    const sourceFile = program.getSourceFile(source)
    const moduleSymbol = sourceFile && checker.getSymbolAtLocation(sourceFile)
    if (!moduleSymbol) throw new Error(`${source} is not a module.`)

    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const symbol =
        exported.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(exported)
          : exported
      const declaration = symbol.declarations?.find((candidate) =>
        candidate.getSourceFile().fileName.startsWith(sourceRoot)
      )
      if (!declaration || visited.has(declaration)) continue
      visited.add(declaration)

      const documentation = ts
        .displayPartsToString(symbol.getDocumentationComment(checker))
        .trim()
      if (!documentation) {
        report(declaration, `${symbol.name} is missing public JSDoc`)
        continue
      }
      checkCallable(symbol, declaration)
    }
  }

  return { failures, declarationCount: visited.size }
}

function run() {
  const entries = packageEntries()
  const { failures, declarationCount } = checkPublicApiDocs({ entries })

  if (failures.length > 0) {
    console.error(failures.join("\n"))
    process.exitCode = 1
  } else {
    console.log(
      `✓ ${declarationCount} public declarations across ${entries.length} entries have JSDoc.`
    )
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  run()
}
