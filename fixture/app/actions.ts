"use server"

import { fixtureBinder } from "@/lib/authority"
import { createItem } from "@/lib/operations"
import { addItem, fixtureProtocol, ITEMS_AXIS } from "@/lib/protocol"
import {
  createNextMutationAction,
  createNextOperationAction,
} from "headcanon/next/server"
import {
  acceptMutation,
  acceptOperation,
  allowAdmission,
  allowScreening,
  denyMutation,
  refuseMutation,
} from "headcanon/server"
import { redirect } from "next/navigation"

/**
 * The fixture's Server Action for {@link addItem}. A `reader` is denied; an
 * item already committed is refused with `item-refused`; an accepted mutation
 * returns its canon on this action's own RSC payload. Pass it as `action` to
 * `createNextPredictedRoot`, or call it with a `MutationEnvelope`.
 */
export const applyFixtureMutation = createNextMutationAction({
  protocol: fixtureProtocol,
  binder: fixtureBinder,
  // No `invalidations`: the fixture has no realtime transport, and the router
  // carrier alone brings canon back.
  commands: [
    fixtureBinder.bind(addItem, {
      screen: ({ actor }) =>
        actor.role === "editor" ? allowScreening() : denyMutation(),
      admit: () => allowAdmission(),
      execute({ tx, args, stamp }) {
        const current = tx.read()
        if (current.items.includes(args.text)) {
          return refuseMutation("item-refused")
        }
        const revision = current.revision + 1
        tx.write({ items: [...current.items, args.text], revision })
        stamp.record(ITEMS_AXIS, revision)
        return acceptMutation()
      },
    }),
  ],
})

/**
 * The fixture's Server Action for {@link createItem}. A `reader` is denied,
 * and a committed item is refused with `item-refused`. The accepted result
 * is the new item's index.
 */
export const createFixtureItem = createNextOperationAction({
  binder: fixtureBinder,
  binding: fixtureBinder.bindOperation(createItem, {
    screen: ({ actor }) =>
      actor.role === "editor" ? allowScreening() : denyMutation(),
    admit: () => allowAdmission(),
    execute({ tx, args, stamp }) {
      const current = tx.read()
      if (current.items.includes(args.text)) {
        return refuseMutation("item-refused")
      }

      const revision = current.revision + 1
      tx.write({ items: [...current.items, args.text], revision })
      stamp.record(ITEMS_AXIS, revision)
      return acceptOperation({ index: current.items.length })
    },
  }),
})

/** {@link createFixtureItem}, redirecting to the new item from the server. */
export async function createFixtureItemAndRedirect(envelope: unknown) {
  const outcome = await createFixtureItem(envelope)
  if (outcome.ok && outcome.value.kind === "accepted") {
    redirect(`/items/${outcome.value.result.index}`)
  }
  return outcome
}
