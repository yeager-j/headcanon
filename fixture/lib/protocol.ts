import type { StandardSchemaV1 } from "@standard-schema/spec"
import { axisId, defineMutation, defineProtocol } from "headcanon"
import { err, ok } from "serializable-result"

/** The one axis the fixture's collection canon observes. */
export const ITEMS_AXIS = axisId("fixture/items")

export interface FixtureState {
  readonly items: readonly string[]
}

export type FixtureRejection = "item-refused"

const addItemArgsSchema: StandardSchemaV1<{ text: string }> = {
  "~standard": {
    version: 1,
    vendor: "headcanon-fixture",
    validate(value: unknown) {
      return typeof value === "object" &&
        value !== null &&
        "text" in value &&
        typeof (value as { text: unknown }).text === "string" &&
        (value as { text: string }).text.length > 0
        ? { value: value as { text: string } }
        : { issues: [{ message: "text must be a non-empty string" }] }
    },
  },
}

const fixtureRejectionSchema: StandardSchemaV1<FixtureRejection> = {
  "~standard": {
    version: 1,
    vendor: "headcanon-fixture",
    validate(value: unknown) {
      return value === "item-refused"
        ? { value }
        : { issues: [{ message: "unknown fixture refusal" }] }
    },
  },
}

/**
 * Appends one item. The predictor and the authority both refuse a duplicate,
 * so the fixture can reach a local refusal, an authority refusal, and a
 * replay conflict.
 */
export const addItem = defineMutation({
  name: "item.add",
  args: addItemArgsSchema,
  refusal: fixtureRejectionSchema,
  predict(state: FixtureState, args) {
    if (state.items.includes(args.text)) return err("item-refused" as const)
    return ok({ items: [...state.items, args.text] })
  },
})

export const fixtureProtocol = defineProtocol({
  id: "fixture",
  mutations: [addItem],
})
