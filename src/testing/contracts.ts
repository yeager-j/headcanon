// `headcanon/testing/contracts`: reusable adapter contract suites. Importing
// this entry imports `vitest`; call the `verify*Contract` functions at the top
// level of a vitest test file. Both suites run in the `node` environment.
export {
  createInMemoryMutationAuthorityContractHarness,
  MUTATION_AUTHORITY_CONTRACT_AXES,
  MUTATION_AUTHORITY_CONTRACT_INITIAL_STATE,
  verifyMutationAuthorityContract,
  type MutationAuthorityContractAxis,
  type MutationAuthorityContractAxisState,
  type MutationAuthorityContractFixture,
  type MutationAuthorityContractHarness,
  type MutationAuthorityContractRefusal,
  type MutationAuthorityContractState,
} from "./suites/authority-contract"
export {
  createInMemoryInvalidationContractHarness,
  verifyInvalidationContract,
  type InvalidationContractFixture,
  type InvalidationContractHarness,
} from "./suites/invalidation-contract"
