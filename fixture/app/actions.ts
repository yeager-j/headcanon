"use server"

import { fixtureBinder } from "@/lib/authority"
import { addItem, fixtureProtocol, ITEMS_AXIS } from "@/lib/protocol"
import { createNextMutationAction } from "headcanon/next/server"
import {
  acceptMutation,
  allowAdmission,
  allowScreening,
  denyMutation,
  refuseMutation,
} from "headcanon/server"

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
