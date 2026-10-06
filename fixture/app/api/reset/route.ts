import { resetFixture } from "@/lib/authority"

/**
 * Test isolation seam: each Playwright test starts from an empty authority
 * with no receipts and no faults.
 */
export function POST(): Response {
  resetFixture()
  return Response.json({ ok: true })
}
