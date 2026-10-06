// Runs before every test file (see `setupFiles` in vitest.config.ts).
//
// Testing Library unmounts rendered trees after each test only when vitest
// globals are on, and they are off here. A root left mounted can hold a React
// Action open, and React entangles pending Actions across roots, so it would
// block transitions in later tests. So every DOM suite unmounts after each
// test; node suites have no DOM and never load Testing Library.
import { afterEach } from "vitest"

if (typeof document !== "undefined") {
  const { cleanup } = await import("@testing-library/react")
  afterEach(cleanup)
}
