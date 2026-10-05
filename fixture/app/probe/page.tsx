import { ITEMS_AXIS } from "@/lib/protocol"
import { authority } from "@/lib/store"

import { ProbeClient } from "./probe-client"

export const dynamic = "force-dynamic"

/**
 * Experiment surface for UNN-682: raw React primitives, no headcanon. Answers
 * which delivery shapes let a Server Action's revalidated RSC payload (or a
 * `router.refresh()`) land while optimistic Actions are held open.
 */
export default function Page() {
  return (
    <ProbeClient
      items={[...authority.items]}
      revision={authority.revision}
      axis={ITEMS_AXIS}
    />
  )
}
