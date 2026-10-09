import { readFixtureCanon } from "@/lib/authority"

export const dynamic = "force-dynamic"

/** One item by its index: where an operation navigates after it creates one. */
export default async function ItemPage({
  params,
}: {
  params: Promise<{ index: string }>
}) {
  const { index } = await params
  const text = readFixtureCanon().value.items[Number(index)]

  return (
    <main>
      <h1>Item {index}</h1>
      <p data-testid="item-text">{text ?? "missing"}</p>
    </main>
  )
}
