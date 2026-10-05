// `headcanon/testing/react`: the reusable refresh incorporation contract.
// Importing this entry imports `vitest` and `@testing-library/react`; run the
// test file in a DOM environment (`// @vitest-environment jsdom`).
export {
  verifyRefreshContract,
  type RefreshContractHarness,
} from "./refresh-contract"
