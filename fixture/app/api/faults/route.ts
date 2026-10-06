import { setFixtureFaults, type FixtureFaults } from "@/lib/authority"

/**
 * Test-only fault switch. The body replaces every fault; omitted ones are
 * off. Any call releases deliveries held by the `hang` fault.
 */
export async function POST(request: Request): Promise<Response> {
  setFixtureFaults((await request.json()) as Partial<FixtureFaults>)
  return Response.json({ ok: true })
}
