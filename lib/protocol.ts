import type { StandardSchemaV1 } from "@standard-schema/spec"

import { axisId, defineMutation, defineProtocol } from "@workspace/headcanon"
import { err, ok } from "@workspace/result"

/** The one axis the fixture's collection canon observes. */
export const ITEMS_AXIS = axisId("fixture/items")

export interface FixtureState {
  readonly items: readonly string[]
}

export type FixtureRejection = "item-refused"

const addItemArgsSchema: StandardSchemaV1<unknown, { text: string }> = {
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

/** Appends one item; refuses a duplicate so rejection paths stay testable. */
export const addItem = defineMutation({
  name: "item.add",
  args: addItemArgsSchema,
  predict(state: FixtureState, args) {
    if (state.items.includes(args.text)) return err("item-refused" as const)
    return ok({ items: [...state.items, args.text] })
  },
})

export const fixtureProtocol = defineProtocol({
  id: "fixture",
  mutations: [addItem],
})
