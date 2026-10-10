import type { StandardSchemaV1 } from "@standard-schema/spec"
import { axisId, defineMutation, defineProtocol } from "headcanon"
import { err, ok } from "serializable-result"

/** The one axis the fixture's collection canon observes. */
export const ITEMS_AXIS = axisId("fixture/items")

/** The fixture's protocol state: the items, in the order they were added. */
export interface FixtureState {
  readonly items: readonly string[]
}

/**
 * Why the predictor or the authority refuses {@link addItem}: the item
 * already exists.
 */
export type FixtureRefusal = "item-refused"

function isAddItemArgs(value: unknown): value is { text: string } {
  if (typeof value !== "object" || value === null) return false
  if (!("text" in value)) return false
  return typeof value.text === "string" && value.text.length > 0
}

const addItemArgsSchema: StandardSchemaV1<{ text: string }> = {
  "~standard": {
    version: 1,
    vendor: "headcanon-fixture",
    validate(value: unknown) {
      return isAddItemArgs(value)
        ? { value }
        : { issues: [{ message: "text must be a non-empty string" }] }
    },
  },
}

/** Parses the fixture's one refusal, for the mutation and the operation. */
export const fixtureRefusalSchema: StandardSchemaV1<FixtureRefusal> = {
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

/** Appends a checked item to the fixture's state. */
export function applyAddItem(
  state: FixtureState,
  effect: { readonly text: string }
): FixtureState {
  return { items: [...state.items, effect.text] }
}

/**
 * Appends one item. The predictor and the authority run the same `check`, so
 * both refuse a duplicate, and the fixture can reach a local refusal, an
 * authority refusal, and a replay conflict.
 */
export const addItem = defineMutation({
  name: "item.add",
  args: addItemArgsSchema,
  refusal: fixtureRefusalSchema,
  check(state: FixtureState, args) {
    if (state.items.includes(args.text)) return err("item-refused")
    return ok({ text: args.text })
  },
  apply: applyAddItem,
})

/**
 * The fixture's protocol, {@link addItem} only, shared by the Server Action
 * and both clients.
 */
export const fixtureProtocol = defineProtocol({
  id: "fixture",
  mutations: [addItem],
})
