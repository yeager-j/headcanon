import { readFixtureCanon } from "@/lib/authority"
import { ITEMS_AXIS } from "@/lib/protocol"
import { revisionAt } from "headcanon"

import { ProbeClient } from "./probe-client"

export const dynamic = "force-dynamic"

/**
 * Experiment surface for UNN-682: raw React primitives, no headcanon client
 * code. Answers which delivery shapes let a Server Action's revalidated RSC
 * payload (or a `router.refresh()`) land while optimistic Actions are held
 * open.
 */
export default function Page() {
  const canon = readFixtureCanon()
  return (
    <ProbeClient
      items={canon.value.items}
      revision={revisionAt(canon.revisions, ITEMS_AXIS) ?? 0}
    />
  )
}
