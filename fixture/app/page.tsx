import { readFixtureCanon } from "@/lib/authority"

import { FixtureClient } from "./fixture-client"

/** The RSC-carried collection canon: every render is a fresh authoritative
 *  observation, so the route must never serve a cached payload. */
export const dynamic = "force-dynamic"

export default function Page() {
  return <FixtureClient canon={readFixtureCanon()} />
}
