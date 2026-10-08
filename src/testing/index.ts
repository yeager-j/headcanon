// `headcanon/testing`: in-memory test doubles. Nothing here imports a test
// framework, so the doubles work in any runner and in a Next server module.
// The reusable refresh contract lives in `headcanon/testing/react` (vitest,
// Testing Library, and a DOM).
export {
  createInMemoryMutationAuthority,
  type InMemoryMutationAuthority,
  type InMemoryReader,
  type InMemoryTransaction,
} from "./in-memory-authority"
export {
  createInMemoryInvalidationAdapter,
  type InMemoryInvalidationAdapter,
} from "./in-memory-invalidation"
