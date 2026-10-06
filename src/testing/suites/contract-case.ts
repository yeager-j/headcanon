/**
 * One named contract case. A `verify*Contract` function registers each case as
 * a vitest `it`; tests also run cases directly against deliberately broken
 * harnesses to prove the contract detects them. Not part of the public API.
 */
export interface ContractCase {
  readonly name: string
  run(): Promise<void>
}
