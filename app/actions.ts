"use server"

import { refresh } from "next/cache"

import {
  acceptedStamp,
  revisionVector,
  type AcceptedStamp,
  type MutationEnvelope,
} from "@workspace/headcanon"
import { err, ok, type Result } from "@workspace/result"

import { addItem, fixtureProtocol, ITEMS_AXIS } from "@/lib/protocol"
import { authority } from "@/lib/store"

type AddItemInvocation = ReturnType<typeof addItem>

/**
 * The fixture's Server Action door: parse the envelope at the trust boundary,
 * recover duplicates from the receipt ledger, apply, then finalize with the
 * server-side `refresh()` the design relies on — the accepted canon rides back
 * on this action's own RSC payload.
 */
export async function applyFixtureMutation(
  envelope: MutationEnvelope<AddItemInvocation>
): Promise<Result<AcceptedStamp, "item-refused">> {
  if (
    envelope.protocol !== fixtureProtocol.id ||
    envelope.invocation.name !== addItem.name ||
    typeof envelope.mutationId !== "string"
  ) {
    throw new Error("fixture executor received a malformed envelope")
  }
  const parsed = await addItem.args["~standard"].validate(
    envelope.invocation.args
  )
  if ("issues" in parsed && parsed.issues) {
    throw new Error("fixture executor received invalid arguments")
  }

  const recorded = authority.receipts.get(envelope.mutationId)
  if (recorded) {
    refresh()
    return ok(recorded)
  }

  const { text } = envelope.invocation.args
  if (authority.items.includes(text)) return err("item-refused")

  authority.items.push(text)
  authority.revision += 1
  const vector = revisionVector({ [ITEMS_AXIS]: authority.revision })
  if (!vector.ok) throw new Error("fixture authority minted an invalid vector")

  const stamp = acceptedStamp(vector.value)
  authority.receipts.set(envelope.mutationId, stamp)
  refresh()
  return ok(stamp)
}
