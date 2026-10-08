import { err, ok } from "serializable-result"
import { describe, expect, it } from "vitest"

import {
  checkDeliveryAge,
  deliveryAgePolicy,
  MutationContentionError,
  type MutationAuthorityRequest,
  type MutationDeliveryAgeError,
} from "../core/authority"
import type { InvalidationSubscription } from "../core/invalidation"
import type { AxisId } from "../core/revisions"
import type { InMemoryReader, InMemoryTransaction } from "./in-memory-authority"
import { createInMemoryInvalidationAdapter } from "./in-memory-invalidation"
import {
  createInMemoryMutationAuthorityContractHarness,
  mutationAuthorityContractCases,
  verifyMutationAuthorityContract,
  type MutationAuthorityContractFixture,
  type MutationAuthorityContractRefusal,
  type MutationAuthorityContractState,
} from "./suites/authority-contract"
import type { ContractCase } from "./suites/contract-case"
import {
  createInMemoryInvalidationContractHarness,
  invalidationContractCases,
  verifyInvalidationContract,
  type InvalidationContractFixture,
} from "./suites/invalidation-contract"

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

const DEFAULT_WINDOW = deliveryAgePolicy({})

/** Whether the default window refuses `request` now with `code`. */
function refusedWith(
  request: MutationAuthorityRequest<unknown, unknown>,
  code: MutationDeliveryAgeError["code"]
): boolean {
  const admitted = checkDeliveryAge(DEFAULT_WINDOW, request, Date.now())
  return !admitted.ok && admitted.error.code === code
}

/** An adapter that admits envelopes the window refuses with `code`. */
function ignoresWindow(code: MutationDeliveryAgeError["code"]) {
  return (fixture: Fixture) =>
    withAuthority(fixture, {
      execute: (request, run) =>
        fixture.authority.execute(
          refusedWith(request, code)
            ? { ...request, createdAt: Date.now() }
            : request,
          run
        ),
    })
}

/** An adapter that refuses by `code` before it looks up the receipt. */
function checksWindowBeforeLookup(code: MutationDeliveryAgeError["code"]) {
  return (fixture: Fixture) =>
    withAuthority(fixture, {
      execute: async (request, run) =>
        refusedWith(request, code)
          ? err({ code, mutationId: request.mutationId })
          : fixture.authority.execute(request, run),
    })
}

/** An adapter that reports `code` instead of a reused mutation ID. */
function checksWindowBeforeCollision(code: MutationDeliveryAgeError["code"]) {
  return (fixture: Fixture) =>
    withAuthority(fixture, {
      execute: async (request, run) => {
        const outcome = await fixture.authority.execute(request, run)
        const reused =
          !outcome.ok && outcome.error.code === "mutation-id-reused"

        return reused && refusedWith(request, code)
          ? err({ code, mutationId: request.mutationId })
          : outcome
      },
    })
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
    flaw: "records a thrown attempt as an acceptance",
    breaks: (fixture) =>
      withAuthority(fixture, {
        execute: (request, run) =>
          fixture.authority.execute(request, async (tx, stamp) => {
            try {
              return await run(tx, stamp)
            } catch {
              return ok(undefined)
            }
          }),
      }),
    caughtBy: "fails loudly when a command accepts without recording an axis",
  },
  {
    flaw: "reports an acceptance with an empty stamp as a denial",
    breaks: (fixture) =>
      withAuthority(fixture, {
        execute: async (request, run) => {
          const outcome = await fixture.authority.execute(request, run)
          const emptyAcceptance =
            outcome.ok &&
            outcome.value.kind === "accepted" &&
            Object.keys(outcome.value.stamp.revisions).length === 0

          return emptyAcceptance ? ok({ kind: "denied" }) : outcome
        },
      }),
    caughtBy:
      "records and replays an explicit no-change acceptance with an empty stamp",
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
  {
    flaw: "executes an expired delivery",
    breaks: ignoresWindow("delivery-expired"),
    caughtBy: "refuses an expired delivery without running or recording it",
  },
  {
    flaw: "executes a future-dated delivery",
    breaks: ignoresWindow("delivery-from-future"),
    caughtBy: "refuses a future-dated delivery without running or recording it",
  },
  {
    flaw: "records an expired delivery as a denial",
    breaks: (fixture) =>
      withAuthority(fixture, {
        execute: (request, run) =>
          refusedWith(request, "delivery-expired")
            ? fixture.authority.execute(
                { ...request, createdAt: Date.now() },
                async () => err({ kind: "denied" })
              )
            : fixture.authority.execute(request, run),
      }),
    caughtBy: "refuses an expired delivery without running or recording it",
  },
  {
    flaw: "checks expiry before replaying a receipt",
    breaks: checksWindowBeforeLookup("delivery-expired"),
    caughtBy: "replays a recorded outcome to an expired redelivery",
  },
  {
    flaw: "checks a future date before replaying a receipt",
    breaks: checksWindowBeforeLookup("delivery-from-future"),
    caughtBy: "replays a recorded outcome to a future-dated redelivery",
  },
  {
    flaw: "reports expiry instead of a reused ID",
    breaks: checksWindowBeforeCollision("delivery-expired"),
    caughtBy:
      "rejects an expired redelivery with another invocation as a reused ID",
  },
  {
    flaw: "reports a future date instead of a reused ID",
    breaks: checksWindowBeforeCollision("delivery-from-future"),
    caughtBy:
      "rejects a future-dated redelivery with another invocation as a reused ID",
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

/** Each mutant breaks one bus rule; the contract must fail every case against it. */
const invalidationMutants: ReadonlyArray<{
  readonly flaw: string
  readonly create: () => InvalidationContractFixture
}> = [
  {
    flaw: "delivers every axis to every subscriber",
    create() {
      const bus = createInMemoryInvalidationAdapter()
      const subscriptions = new Set<InvalidationSubscription>()
      return {
        adapter: {
          initialStatus: "active",
          subscribe(subscription) {
            subscriptions.add(subscription)
            return () => subscriptions.delete(subscription)
          },
        },
        publisher: {
          onFailure: bus.onFailure,
          publish(eventId, stamp) {
            bus.publish(eventId, stamp)
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
    },
  },
  {
    flaw: "keeps delivering after unsubscribe",
    create() {
      const bus = createInMemoryInvalidationAdapter()
      return {
        adapter: {
          initialStatus: "active",
          subscribe(subscription) {
            bus.subscribe(subscription)
            return () => undefined
          },
        },
        publisher: bus,
        published: () => bus.published,
        settled: async () => undefined,
      }
    },
  },
]

describe("invalidation contract negative controls", () => {
  it.each(invalidationMutants)("fails a bus that $flaw", async ({ create }) => {
    const cases = invalidationContractCases({ name: "broken", create })

    expect(await failingCaseNames(cases)).toEqual(cases.map(({ name }) => name))
  })
})
