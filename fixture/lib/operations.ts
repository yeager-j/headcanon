import type { StandardSchemaV1 } from "@standard-schema/spec"
import { defineOperation } from "headcanon"

import { fixtureRefusalSchema } from "./protocol"

/** What {@link createItem} returns: where the new item is in the list. */
export interface CreatedItem {
  /** The item's zero-based position in the list. */
  readonly index: number
}

const createItemArgsSchema: StandardSchemaV1<{ text: string }> = {
  "~standard": {
    version: 1,
    vendor: "headcanon-fixture",
    validate(value: unknown) {
      const text = (value as { text?: unknown } | null)?.text
      return typeof text === "string" && text.length > 0
        ? { value: { text } }
        : { issues: [{ message: "text must be a non-empty string" }] }
    },
  },
}

const createdItemSchema: StandardSchemaV1<CreatedItem> = {
  "~standard": {
    version: 1,
    vendor: "headcanon-fixture",
    validate(value: unknown) {
      const index = (value as { index?: unknown } | null)?.index
      return typeof index === "number" && Number.isSafeInteger(index)
        ? { value: { index } }
        : { issues: [{ message: "index must be a safe integer" }] }
    },
  },
}

/**
 * Appends one item outside the protocol and returns its index, which only
 * the server knows. A duplicate is refused with `item-refused`.
 */
export const createItem = defineOperation({
  name: "fixture.item.create.v1",
  args: createItemArgsSchema,
  result: createdItemSchema,
  refusal: fixtureRefusalSchema,
})
