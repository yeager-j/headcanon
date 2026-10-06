import { inspectFixtureAuthority, writeAsAnotherClient } from "@/lib/authority"

/** Committed items, revision, and receipt count, for test assertions. */
export function GET(): Response {
  return Response.json(inspectFixtureAuthority())
}

/** Commits `{ text }` as another client would, without telling this one. */
export async function POST(request: Request): Promise<Response> {
  const { text } = (await request.json()) as { text: string }
  writeAsAnotherClient(text)
  return Response.json({ ok: true })
}
