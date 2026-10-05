import { describe, expect, it } from "vitest"

import { MutationContentionError } from "../authority"
import type { InvalidationSubscription } from "../invalidation"
import type { AxisId } from "../revisions"
import {
  createInMemoryMutationAuthorityContractHarness,
  mutationAuthorityContractCases,
  type MutationAuthorityContractFixture,
  type MutationAuthorityContractRefusal,
  type MutationAuthorityContractState,
} from "./authority-contract"
import type { ContractCase } from "./contract-case"
import {
  createInMemoryInvalidationContractHarness,
  verifyInvalidationContract,
  verifyMutationAuthorityContract,
} from "./contracts"
import type { InMemoryReader, InMemoryTransaction } from "./in-memory-authority"
import { createInMemoryInvalidationAdapter } from "./in-memory-invalidation"
import {
  invalidationContractCases,
  type InvalidationContractFixture,
} from "./invalidation-contract"

verifyMutationAuthorityContract(
  createInMemoryMutationAuthorityContractHarness()
)
verifyInvalidationContract(createInMemoryInvalidationContractHarness())

async function failingCaseNames(
  cases: readonly ContractCase[]
): Promise<string[]> {
  const failing: string[] = []
  for (const contractCase of cases) {
    try {
      await contractCase.run()
    } catch {
      failing.push(contractCase.name)
    }
  }
  return failing
}

type State = MutationAuthorityContractState
type Fixture = MutationAuthorityContractFixture<
  InMemoryTransaction<State>,
  InMemoryReader<State>
>
type Authority = Fixture["authority"]

function withAuthority(
  fixture: Fixture,
  authority: Partial<Authority>
): Fixture {
  return { ...fixture, authority: { ...fixture.authority, ...authority } }
}

/** Each mutant breaks one authority rule and names the case that must catch it. */
const authorityMutants: ReadonlyArray<{
  readonly flaw: string
  readonly breaks: (fixture: Fixture) => Fixture
  readonly caughtBy: string
}> = [
  {
    flaw: "reruns a redelivered mutation instead of replaying its receipt",
    breaks: (fixture) =>
      withAuthority(fixture, {
        execute: (request, run) =>
          fixture.authority.execute(
            { ...request, mutationId: crypto.randomUUID() },
            run
          ),
      }),
    caughtBy:
      "returns recorded duplicates without rerunning and rejects ID collisions",
  },
  {
    flaw: "stamps only the last axis an attempt records",
    breaks: (fixture) =>
      withAuthority(fixture, {
        execute: (request, run) =>
          fixture.authority.execute(request, async (tx, stamp) => {
            let last: [AxisId, number] | undefined
            const attempted = await run(tx, {
              record: (axis, revision) => {
                last = [axis, revision]
              },
            })
            if (last) stamp.record(...last)
            return attempted
          }),
      }),
    caughtBy: "records every committed axis atomically in the accepted vector",
  },
  {
    flaw: "commits attempt-local writes before the attempt settles",
    breaks: (fixture) => ({
      ...fixture,
      async appendEffect(_tx, effect) {
        const committed = await fixture.load(fixture.authority.preflight)
        await fixture.replace({
          ...committed,
          effects: [...committed.effects, effect],
        })
      },
    }),
    caughtBy:
      "rolls back partial handler work before recording a terminal refusal",
  },
  {
    flaw: "records and replays refusals without the request's parser",
    breaks: (fixture) =>
      withAuthority(fixture, {
        execute: (request, run) =>
          fixture.authority.execute(
            {
              ...request,
              parseRefusal:
                request.parseRefusal ??
                ((value) => value as MutationAuthorityContractRefusal),
            },
            run
          ),
      }),
    caughtBy:
      "fails closed when a refusal crosses the receipt boundary without a parser",
  },
  {
    flaw: "propagates a thrown contention instead of rerunning the attempt",
    breaks: (fixture) =>
      withAuthority(fixture, {
        execute: (request, run) =>
          fixture.authority.execute(request, async (tx, stamp) => {
            try {
              return await run(tx, stamp)
            } catch (error) {
              if (error instanceof MutationContentionError) {
                throw new Error("contention escaped the authority")
              }
              throw error
            }
          }),
      }),
    caughtBy:
      "reruns load and handler after one CAS loss without retaining attempt effects",
  },
  {
    flaw: "screens through the in-flight attempt's uncommitted state",
    breaks: (fixture) => {
      let inFlight: InMemoryTransaction<State> | undefined
      return withAuthority(fixture, {
        preflight: {
          read: () => (inFlight ?? fixture.authority.preflight).read(),
        },
        execute: (request, run) =>
          fixture.authority.execute(request, async (tx, stamp) => {
            inFlight = tx
            try {
              return await run(tx, stamp)
            } finally {
              inFlight = undefined
            }
          }),
      })
    },
    caughtBy:
      "screens through a preflight executor that sees only committed state",
  },
]

describe("authority contract negative controls", () => {
  it.each(authorityMutants)(
    "fails an adapter that $flaw",
    async ({ breaks, caughtBy }) => {
      const healthy = createInMemoryMutationAuthorityContractHarness()
      const broken = {
        name: "broken",
        create: async () => breaks(await healthy.create()),
      }

      expect(
        await failingCaseNames(mutationAuthorityContractCases(broken))
      ).toContain(caughtBy)
    }
  )
})

function brokenInvalidationFixture(
  flaw: "ignores-axes" | "keeps-subscriptions"
): InvalidationContractFixture {
  const bus = createInMemoryInvalidationAdapter()
  const subscriptions = new Set<InvalidationSubscription>()
  return {
    adapter: {
      initialStatus: "active",
      subscribe(subscription) {
        subscriptions.add(subscription)
        if (flaw === "keeps-subscriptions") {
          bus.subscribe(subscription)
          return () => undefined
        }
        return () => subscriptions.delete(subscription)
      },
    },
    publisher: {
      publish(eventId, stamp) {
        bus.publish(eventId, stamp)
        if (flaw !== "ignores-axes") return
        for (const invalidation of bus.published.filter(
          (entry) => entry.eventId === eventId
        )) {
          for (const subscription of subscriptions) {
            subscription.onInvalidation(invalidation)
          }
        }
      },
    },
    published: () => bus.published,
    settled: async () => undefined,
  }
}

describe("invalidation contract negative controls", () => {
  it.each(["ignores-axes", "keeps-subscriptions"] as const)(
    "fails a bus that %s",
    async (flaw) => {
      const cases = invalidationContractCases({
        name: "broken",
        create: () => brokenInvalidationFixture(flaw),
      })

      expect(await failingCaseNames(cases)).toEqual(
        cases.map(({ name }) => name)
      )
    }
  )
})
