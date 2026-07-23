import { readdirSync } from "node:fs"
import { extname, join, relative, resolve } from "node:path"
import process from "node:process"
import ts from "typescript"

const packageRoot = resolve(import.meta.dirname, "..")
const sourceRoot = join(packageRoot, "src")
const entryPoints = [
  "index.ts",
  "ably/channels.ts",
  "ably/client.ts",
  "ably/server.ts",
  "drizzle.ts",
  "receipt-table.ts",
  "next/client.ts",
  "next/server.ts",
  "react.ts",
  "testing.ts",
]

const sourceFiles = []
function collect(directory) {
  for (const name of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, name.name)
    if (name.isDirectory()) collect(file)
    else if (extname(file) === ".ts" && !file.endsWith(".test.ts")) {
      sourceFiles.push(file)
    }
  }
}
collect(sourceRoot)

const program = ts.createProgram(sourceFiles, {
  allowJs: false,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noEmit: true,
  skipLibCheck: true,
  strict: true,
  target: ts.ScriptTarget.ES2022,
})
const checker = program.getTypeChecker()
const failures = []
const visited = new Set()

function definingSymbol(symbol) {
  return symbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(symbol)
    : symbol
}

function sourceDeclaration(symbol) {
  return symbol.declarations?.find((declaration) =>
    declaration.getSourceFile().fileName.startsWith(sourceRoot)
  )
}

function report(declaration, message) {
  const sourceFile = declaration.getSourceFile()
  const position = sourceFile.getLineAndCharacterOfPosition(
    declaration.getStart(sourceFile)
  )
  failures.push(
    `${relative(packageRoot, sourceFile.fileName)}:${position.line + 1} ${message}`
  )
}

function tagsFor(declaration) {
  return ts.getJSDocTags(declaration)
}

function hasDocumentation(symbol) {
  return ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim()
}

function callableSignatures(declaration) {
  const type = checker.getTypeAtLocation(declaration)
  return type.getCallSignatures()
}

function checkCallable(symbol, declaration) {
  const signatures = callableSignatures(declaration)
  if (signatures.length === 0) return

  const tags = tagsFor(declaration)
  const paramNames = new Set(
    tags
      .filter((tag) => tag.tagName.text === "param")
      .map((tag) => tag.name?.getText())
  )
  for (const signature of signatures) {
    for (const parameter of signature.parameters) {
      const name = parameter.getName()
      if (!paramNames.has(name)) {
        report(declaration, `${symbol.name} is missing @param ${name}`)
      }
    }
  }
  if (!tags.some((tag) => tag.tagName.text === "returns")) {
    report(declaration, `${symbol.name} is missing @returns`)
  }
}

for (const entryPoint of entryPoints) {
  const fileName = join(sourceRoot, entryPoint)
  const sourceFile = program.getSourceFile(fileName)
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile)
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const symbol = definingSymbol(exported)
    const declaration = sourceDeclaration(symbol)
    if (!declaration || visited.has(declaration)) continue
    visited.add(declaration)

    if (!hasDocumentation(symbol)) {
      report(declaration, `${symbol.name} is missing public JSDoc`)
      continue
    }
    checkCallable(symbol, declaration)
  }
}

if (failures.length > 0) {
  globalThis.console.error(failures.join("\n"))
  process.exitCode = 1
} else {
  globalThis.console.log(
    `Checked ${visited.size} public declarations across ${entryPoints.length} entry points.`
  )
}
