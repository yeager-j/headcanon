import { resetAuthority } from "@/lib/store"

/** Test isolation seam: each Playwright test starts from an empty authority. */
export function POST(): Response {
  resetAuthority()
  return Response.json({ ok: true })
}
