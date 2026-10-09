import { OperationClient } from "./operation-client"

export const dynamic = "force-dynamic"

/**
 * A form that creates an item through an operation. `?redirect=server` uses
 * the action that redirects from the server; otherwise the client navigates.
 */
export default async function OperationPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string }>
}) {
  const { redirect } = await searchParams
  return (
    <OperationClient redirect={redirect === "server" ? "server" : "client"} />
  )
}
