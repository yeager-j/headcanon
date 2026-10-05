// @vitest-environment jsdom

import { describe, expect, it } from "vitest"

import { acceptedStamp, axisId, covers, revisionVector } from "./revisions"
import {
  assertMutationAuthorityContractAccumulation,
  assertMutationAuthorityContractRollback,
  assertRefreshContractStalled,
  createInMemoryInvalidationContractHarness,
  createInMemoryMutationAuthorityContractHarness,
  MUTATION_AUTHORITY_CONTRACT_INITIAL_STATE,
  verifyInvalidationContract,
  verifyMutationAuthorityContract,
  verifyPollingFallbackContract,
} from "./testing"

verifyMutationAuthorityContract(
  createInMemoryMutationAuthorityContractHarness()
)
verifyInvalidationContract(createInMemoryInvalidationContractHarness())
verifyPollingFallbackContract()

describe("contract negative controls", () => {
  const first = axisId("negative-control/first")
  const second = axisId("negative-control/second")

  function vector(entries: Record<string, number>) {
    const parsed = revisionVector(entries)
    if (!parsed.ok) throw new Error("Invalid negative-control vector")
    return parsed.value
  }

  it("makes the accumulation assertion fail for a last-axis-only mutant", () => {
    const lastAxisOnly = acceptedStamp(vector({ [second]: 1 }))
    const committedState = {
      ...MUTATION_AUTHORITY_CONTRACT_INITIAL_STATE,
      primary: 1,
      secondary: 1,
      revisions: { primary: 1, secondary: 1, rollbackOnly: 0 },
      effects: ["multi-axis"],
    }

    expect(() =>
      assertMutationAuthorityContractAccumulation(lastAxisOnly, committedState)
    ).toThrow()
  })

  it("makes the rollback assertion fail when attempt-local work leaks", () => {
    const leakingMutant = {
      ...MUTATION_AUTHORITY_CONTRACT_INITIAL_STATE,
      primary: 1,
      revisions: { primary: 1, secondary: 0, rollbackOnly: 0 },
      effects: ["first-attempt"],
    }

    expect(() =>
      assertMutationAuthorityContractRollback(leakingMutant)
    ).toThrow()
  })

  it("makes the coverage assertion fail for partial multi-axis canon", () => {
    const stamp = acceptedStamp(vector({ [first]: 1, [second]: 1 }))
    const partialCanon = { value: null, revisions: vector({ [first]: 1 }) }
    const anyAxisCovers: typeof covers = (canon, accepted) =>
      Object.entries(accepted.revisions).some(
        ([rawAxis, acceptedRevision]) =>
          (canon.revisions[axisId(rawAxis)] ?? -1) >= acceptedRevision
      )

    const coverageProperty = (implementation: typeof covers) =>
      !implementation(partialCanon, stamp)

    expect(coverageProperty(covers)).toBe(true)
    expect(coverageProperty(anyAxisCovers)).toBe(false)
  })

  it("makes the stall assertion fail for a never-stalling mutant", () => {
    const neverStalls = {
      freshness: "refreshing" as const,
      invalidations: "disabled" as const,
      missingAxes: [],
      stallReason: null,
    }

    expect(() => assertRefreshContractStalled(neverStalls)).toThrow()
  })
})
