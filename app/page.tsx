import { defineCanon } from "@workspace/headcanon"

import { ITEMS_AXIS } from "@/lib/protocol"
import { authority } from "@/lib/store"

import { FixtureClient } from "./fixture-client"

/** The RSC-carried collection canon: every render is a fresh authoritative
 *  observation, so the route must never serve a cached payload. */
export const dynamic = "force-dynamic"

export default function Page() {
  const canon = defineCanon({
    value: { items: [...authority.items] },
    revisions: { [ITEMS_AXIS]: authority.revision },
  })

  return <FixtureClient canon={canon} />
}
