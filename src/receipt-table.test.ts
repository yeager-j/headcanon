import { readFileSync } from "node:fs"
import { is, SQL } from "drizzle-orm"
import { getTableConfig, PgDialect, type PgColumn } from "drizzle-orm/pg-core"
import { describe, expect, it } from "vitest"

import { headcanonMutationReceipts } from "./receipt-table"

const checkedInSql = readFileSync(
  new URL("../drizzle/0000_headcanon_mutation_receipts.sql", import.meta.url),
  "utf8"
)

function columnSql(column: PgColumn): string {
  const parts = [`"${column.name}"`, column.getSQLType()]
  if (column.default !== undefined) {
    if (!is(column.default, SQL)) {
      throw new Error(`Render a literal default for column: ${column.name}`)
    }
    parts.push(`DEFAULT ${new PgDialect().sqlToQuery(column.default).sql}`)
  }
  if (column.notNull) parts.push("NOT NULL")
  return parts.join(" ")
}

/**
 * Renders the table definition as the statements drizzle-kit generates for a
 * new table, covering only the column, key, and index features the receipt
 * table uses. An unsupported feature throws rather than rendering wrongly.
 */
function renderTableSql(): string[] {
  const table = getTableConfig(headcanonMutationReceipts)
  if (
    table.foreignKeys.length > 0 ||
    table.uniqueConstraints.length > 0 ||
    table.checks.length > 0 ||
    table.primaryKeys.length !== 1
  ) {
    throw new Error("Extend the receipt-table renderer for the new feature")
  }
  const [primaryKey] = table.primaryKeys
  const keyColumns = primaryKey!.columns.map(({ name }) => `"${name}"`)
  const create = [
    `CREATE TABLE "${table.name}" (`,
    [
      ...table.columns.map((column) => `\t${columnSql(column)}`),
      `\tCONSTRAINT "${primaryKey!.getName()}" PRIMARY KEY(${keyColumns.join(", ")})`,
    ].join(",\n"),
    ");",
  ].join("\n")

  const indexes = table.indexes.map(({ config }) => {
    const columns = config.columns.map((column) => {
      if (is(column, SQL) || !("name" in column)) {
        throw new Error("Extend the receipt-table renderer for SQL indexes")
      }
      return `"${column.name}"`
    })
    return `CREATE ${config.unique ? "UNIQUE " : ""}INDEX "${config.name}" ON "${table.name}" USING ${config.method ?? "btree"} (${columns.join(", ")});`
  })

  return [create, ...indexes]
}

describe("receipt table migration", () => {
  it("matches the Drizzle table definition statement for statement", () => {
    const statements = checkedInSql
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0)

    expect(statements).toEqual(renderTableSql())
  })
})
