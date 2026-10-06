import { describe, expect, it, vi } from "vitest"

import type {
  AxisInvalidation,
  InvalidationAdapter,
  InvalidationPublisher,
} from "../../core/invalidation"
import { acceptedStamp, axisId, type AcceptedStamp } from "../../core/revisions"
import { createInMemoryInvalidationAdapter } from "../in-memory-invalidation"
import type { ContractCase } from "./contract-case"

/**
 * What one invalidation contract case exercises: the adapter under test and
 * the publisher that feeds it.
 */
export interface InvalidationContractFixture {
  /** The subscription side under test. */
  readonly adapter: InvalidationAdapter
  /** Publishes accepted stamps to `adapter`'s subscribers. */
  readonly publisher: InvalidationPublisher
  /**
   * Every per-axis entry `publisher` has sent, in publish order. Each entry
   * has only `eventId`, `axis`, and `revision`.
   */
  readonly published: () => readonly AxisInvalidation[]
  /**
   * Resolves once the subscriptions made so far are live, so a publication
   * reaches them. The contract awaits it after subscribing.
   */
  readonly settled: () => Promise<void>
}

/**
 * Names an invalidation adapter under test and creates a fresh fixture for
 * each contract case.
 */
export interface InvalidationContractHarness {
  /** Label that prefixes the contract's `describe` block. */
  readonly name: string
  /** Creates an isolated fixture. Called once per case. */
  create(): InvalidationContractFixture | Promise<InvalidationContractFixture>
}

/**
 * A ready-to-run in-memory harness for `verifyInvalidationContract`.
 * @returns A harness that creates an isolated in-memory bus per case.
 */
export function createInMemoryInvalidationContractHarness(): InvalidationContractHarness {
  return {
    name: "in-memory",
    create() {
      const invalidations = createInMemoryInvalidationAdapter()
      return {
        adapter: invalidations,
        publisher: invalidations,
        published: () => invalidations.published,
        settled: async () => undefined,
      }
    },
  }
}

const INVALIDATION_AXIS_A = axisId("headcanon/invalidation-contract/a")
const INVALIDATION_AXIS_B = axisId("headcanon/invalidation-contract/b")
const INVALIDATION_AXIS_UNRELATED = axisId(
  "headcanon/invalidation-contract/unrelated"
)

function invalidationStamp(entries: Record<string, number>): AcceptedStamp {
  const parsed = acceptedStamp({ revisions: entries })
  if (!parsed.ok) throw new Error("Invalid invalidation contract stamp")
  return parsed.value
}

/**
 * The invalidation contract's cases for one harness. Internal to the package:
 * tests use it to run the cases against deliberately broken harnesses.
 * @param harness The adapter's harness; `create` runs once per case.
 * @returns The contract cases, in order.
 */
export function invalidationContractCases(
  harness: InvalidationContractHarness
): readonly ContractCase[] {
  return [
    {
      name: "isolates axes, publishes singleton entries, and cleans up subscriptions",
      async run() {
        const fixture = await harness.create()
        const a = vi.fn()
        const b = vi.fn()
        const unrelated = vi.fn()
        const stopA = fixture.adapter.subscribe({
          axes: [INVALIDATION_AXIS_A],
          onInvalidation: a,
          onStatusChange: vi.fn(),
        })
        fixture.adapter.subscribe({
          axes: [INVALIDATION_AXIS_B],
          onInvalidation: b,
          onStatusChange: vi.fn(),
        })
        fixture.adapter.subscribe({
          axes: [INVALIDATION_AXIS_UNRELATED],
          onInvalidation: unrelated,
          onStatusChange: vi.fn(),
        })
        await fixture.settled()

        await fixture.publisher.publish(
          "shared-event",
          invalidationStamp({
            [INVALIDATION_AXIS_A]: 1,
            [INVALIDATION_AXIS_B]: 2,
          })
        )

        expect(a).toHaveBeenCalledExactlyOnceWith({
          eventId: "shared-event",
          axis: INVALIDATION_AXIS_A,
          revision: 1,
        })
        expect(b).toHaveBeenCalledExactlyOnceWith({
          eventId: "shared-event",
          axis: INVALIDATION_AXIS_B,
          revision: 2,
        })
        expect(unrelated).not.toHaveBeenCalled()
        expect(fixture.published()).toEqual([
          {
            eventId: "shared-event",
            axis: INVALIDATION_AXIS_A,
            revision: 1,
          },
          {
            eventId: "shared-event",
            axis: INVALIDATION_AXIS_B,
            revision: 2,
          },
        ])
        const publishedKeys = fixture
          .published()
          .map((entry) => Object.keys(entry).sort())
        expect(publishedKeys).toEqual([
          ["axis", "eventId", "revision"],
          ["axis", "eventId", "revision"],
        ])

        stopA()
        await fixture.publisher.publish(
          "after-unsubscribe",
          invalidationStamp({ [INVALIDATION_AXIS_A]: 3 })
        )
        expect(a).toHaveBeenCalledTimes(1)
      },
    },
  ]
}

/**
 * Runs the reusable black-box invalidation contract against one adapter.
 * Registers one vitest `describe` block, so call it at a test file's top
 * level. Runs in the `node` environment unless the adapter itself needs a DOM.
 * @param harness The adapter's harness; `create` runs once per case.
 * @returns Nothing; registers the contract's tests.
 */
export function verifyInvalidationContract(
  harness: InvalidationContractHarness
): void {
  describe(`${harness.name} invalidation contract`, () => {
    for (const contractCase of invalidationContractCases(harness)) {
      it(contractCase.name, () => contractCase.run())
    }
  })
}
