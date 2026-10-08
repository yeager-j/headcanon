# Testing

Test the decisions your application owns: what a mutation predicts, who may run it, what the transaction saves, and what users see while confirmation is pending. Headcanon provides in-memory test doubles and reusable contracts for custom adapters.

This guide uses Vitest and the note protocol from [Getting started](getting-started.md). The React examples control delivery and canon separately, so they need no running Next.js server, database, or Ably connection.

## Choose the test boundary

| What you want to check                                                           | Where to test it                                               |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| A predicted value or local refusal                                               | Call the mutation's `predict` function directly.               |
| Permissions, database writes, revision increments, and stored outcomes           | Run your server commands against an isolated test database.    |
| Pending UI, acceptance, canonization, and recovery controls                      | Render a root or component with controlled delivery and canon. |
| How a view responds to remote revisions                                          | Use the in-memory invalidation adapter.                        |
| A custom authority, invalidation transport, or refresh adapter                   | Run the matching contract suite.                               |
| Server Actions, cache invalidation, route refresh, and realtime working together | Use browser tests against the running application.             |

## Install test dependencies

For the examples below:

```sh
npm install --save-dev vitest @testing-library/react jsdom
```

Configure your test runner to resolve the same `@/` alias as your application. The examples import `@/lib/notes/protocol` from Getting started, which already uses Zod and `serializable-result`.

Command modules import `headcanon/server`, which loads no Next.js code, so a test of a command module needs no extra configuration. Tests that import `headcanon/next/server` or `headcanon/next/client`, directly or through your action and root modules, also need Vitest to process Headcanon instead of loading it as an external package:

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    server: {
      deps: {
        inline: ["headcanon"],
      },
    },
  },
})
```

Next.js publishes no package `exports` map, so Node cannot resolve Headcanon's `next/cache` and `next/navigation` imports outside a Next build ([vercel/next.js#77200](https://github.com/vercel/next.js/issues/77200)). Inlining lets Vitest resolve them, and lets `vi.mock("next/cache")` apply to Headcanon's own imports.

Headcanon keeps its test helpers in separate entries:

| Entry                         | Contents                                                                           | Requirements                                                           |
| ----------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `headcanon/testing`           | In-memory authority and invalidation bus                                           | No test framework; works with any runner or in a local server fixture. |
| `headcanon/testing/contracts` | Authority and invalidation contract suites, harness types, and reference harnesses | Vitest; Node environment unless your adapter needs a DOM.              |
| `headcanon/testing/react`     | Refresh contract suite and its harness type                                        | Vitest, Testing Library, and a DOM such as jsdom.                      |

The contract entries support Vitest `^4.1.6`; the React contract also requires Testing Library `^16.3.2`. Import the framework-free doubles from `headcanon/testing`, not from a contract entry.

## Test a predictor directly

A predictor takes the current value, parsed arguments, and a mutation context. Test its successful result, refusal cases, and whether it leaves the input unchanged:

```ts
// lib/notes/protocol.test.ts
import { renameNote } from "@/lib/notes/protocol"
import { err, ok } from "serializable-result"
import { expect, it } from "vitest"

const noteId = "00000000-0000-4000-8000-000000000001"
const context = {
  mutationId: "00000000-0000-4000-8000-000000000002",
}

it("predicts a title without changing the input", () => {
  const state = Object.freeze({ id: noteId, title: "Before" })
  const args = { noteId, title: "After" }

  expect(renameNote.predict(state, args, context)).toEqual(
    ok({ id: noteId, title: "After" })
  )
  expect(renameNote.predict(state, args, context)).toEqual(
    renameNote.predict(state, args, context)
  )
  expect(state.title).toBe("Before")
})

it("refuses an empty title", () => {
  expect(
    renameNote.predict(
      { id: noteId, title: "Before" },
      { noteId, title: "   " },
      context
    )
  ).toEqual(err("invalid-title"))
})
```

Calling `predict` directly does not validate arguments through the mutation's schema. Test malformed wire inputs at the Server Action boundary as well. For predictors that create IDs, use `context.mutationId` and check that replay with the same context produces the same result.

## Test server behavior

For the Drizzle commands in [Server setup](server-setup.md), use a test database with both your application tables and Headcanon's receipt table. Give each test isolated data and call the generated action with an envelope containing `protocol`, a UUID `mutationId`, `createdAt: Date.now()`, and the mutation invocation.

Check the returned outcome, committed rows, revisions, and receipts together:

| Case                                                     | Expected result                                                                                                                                                                              |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Malformed envelope or arguments                          | Executor error before actor lookup or command execution.                                                                                                                                     |
| Screening denies access                                  | `ok({ kind: "denied" })`; no receipt and no write.                                                                                                                                           |
| Transaction-time admission denies access                 | Recorded denial; no domain write.                                                                                                                                                            |
| A command refuses after making tentative writes          | Domain writes roll back; the refusal is recorded.                                                                                                                                            |
| A command accepts                                        | Writes, revision increments, and the receipt commit together. Its stamp contains every affected axis.                                                                                        |
| The same envelope is delivered twice                     | The recorded outcome replays without another transactional write. Screening runs again; accepted finalization also runs again.                                                               |
| The same scoped ID is reused with different arguments    | `mutation-id-reused`, if screening allows the request to reach receipt lookup.                                                                                                               |
| A new envelope is older than the delivery window         | `delivery-expired` after screening; no receipt and no write. A redelivery of a recorded ID still replays its outcome.                                                                        |
| A new envelope is dated too far in the future            | `delivery-from-future` after screening; no receipt and no write.                                                                                                                             |
| A concurrent write wins and the guarded write detects it | Admission and execution retry with fresh state and a fresh stamp, up to `maxAttempts`. Exhaustion returns `contention` without a receipt. A race the command does not detect is not retried. |

Also check that `finalizeAccepted` is safe to repeat. Publication failure must leave an accepted write accepted and call your publisher's `onFailure`. See [Server setup](server-setup.md) for the distinction between terminal outcomes and executor errors.

A test that calls a command's `screen`, `admit`, or `execute` directly, or binds commands to an in-memory authority, imports only `headcanon/server` and needs no mocks.

Calling a generated action in a unit test requires a substitute for Next's request-bound cache functions. With Headcanon inlined as shown above, mock them in the action test file:

```ts
// lib/notes/actions.test.ts — add alongside your action tests
import { vi } from "vitest"

vi.mock("next/cache", () => ({
  updateTag: vi.fn(),
  refresh: vi.fn(),
}))
```

Provide your normal test session through the binder's actor callback too. These mocks let action logic run outside a request; use a browser test to verify actual Next cache and route behavior. If an imported application module uses `server-only`, configure your runner's test-only alias or mock for that marker.

### Use the in-memory authority for fixtures

`createInMemoryMutationAuthority` provides isolated state, transaction attempts, and receipts without a database. Pass it directly to `createMutationBinder`:

```ts
// test/notes-authority.ts
import type { NoteState } from "@/lib/notes/protocol"
import { createMutationBinder } from "headcanon/server"
import { createInMemoryMutationAuthority } from "headcanon/testing"

type StoredNote = NoteState & { ownerId: string; revision: number }
type Actor = { userId: string }

export function createNotesFixture(initialState: StoredNote) {
  const actor: Actor = { userId: initialState.ownerId }
  const authority = createInMemoryMutationAuthority<
    StoredNote,
    Actor,
    "invalid-title"
  >({
    initialState,
    scope: (actor) => actor.userId,
  })
  const binder = createMutationBinder({ actor: () => actor, authority })

  return { actor, authority, binder }
}
```

Create a new fixture for each test. Bind fixture commands with this binder and pass the same binder to `createNextMutationAction`. Its preflight executor has `read()`; its transaction has `read()` and `write(nextState)`. Commands still check permissions, advance revisions, and record their stamps.

This is an in-memory state store, not a Drizzle client. Commands that call `tx.select()` or `tx.update()` need a real test database or an application storage interface with its own test implementation. A replacement fixture command does not verify your production SQL.

| Control                                   | Use                                                                                                                                                   |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `authority.read()`                        | Inspect a copy of committed state.                                                                                                                    |
| `authority.replace(next)`                 | Commit state outside an attempt, as another writer would.                                                                                             |
| `authority.contendNext(update?)`          | Commit a competing update after the next attempt's command returns or throws. If that attempt writes and would accept, it loses the race and retries. |
| `authority.receiptCount()`                | Count stored receipts.                                                                                                                                |
| `authority.hasReceipt(actor, mutationId)` | Check for a receipt in an actor's scope.                                                                                                              |

The default attempt limit is two; pass `maxAttempts` to change it. The delivery window uses `Date.now()` and the same `maxDeliveryAgeMs` and `clockSkewToleranceMs` options as the Drizzle adapter, so `vi.setSystemTime()` can move an envelope out of it. Queue one `contendNext` call per attempt to test exhaustion; each queued update is consumed by one attempt, even if that attempt refuses. State uses `structuredClone` by default; provide `clone` when your fixture needs another copying strategy.

## Test prediction, acceptance, and canonization separately

The root keeps an accepted prediction until canon covers its revisions. Use a controlled sender to test each stage:

```ts
// lib/notes/predictions.test.ts
// @vitest-environment jsdom
import { noteAxis, notesProtocol, renameNote } from "@/lib/notes/protocol"
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { acceptedStamp, defineCanon } from "headcanon"
import { createPredictedRoot, useSnapshotRefresh } from "headcanon/react"
import { ok } from "serializable-result"
import { afterEach, expect, it, vi } from "vitest"

afterEach(cleanup)

it("keeps the prediction until canon covers the accepted revision", async () => {
  const noteId = "00000000-0000-4000-8000-000000000001"
  const axis = noteAxis(noteId)
  const canon = (title: string, revision: number) =>
    defineCanon({
      value: { id: noteId, title },
      revisions: { [axis]: revision },
    })
  const parsed = acceptedStamp({ revisions: { [axis]: 1 } })
  if (!parsed.ok) throw new Error("Invalid test stamp")
  const stamp = parsed.value

  let release!: () => void
  const delivery = new Promise<void>((resolve) => {
    release = resolve
  })
  const send = vi.fn(async () => {
    await delivery
    return ok(stamp)
  })
  const refetch = vi.fn(async () => undefined)
  const useNotes = createPredictedRoot({
    protocol: notesProtocol,
    send,
    refresh: () => useSnapshotRefresh(refetch),
  })
  const { result, rerender } = renderHook(
    ({ currentCanon }) => useNotes({ canon: currentCanon }),
    { initialProps: { currentCanon: canon("Before", 0) } }
  )
  const onCanonization = vi.fn()

  act(() => {
    result.current.mutate(renameNote({ noteId, title: "After" }), {
      onCanonization,
    })
  })
  expect(result.current.value.title).toBe("After")
  expect(result.current.status.pending).toBe(1)
  await waitFor(() => expect(send).toHaveBeenCalledOnce())

  await act(async () => release())
  await waitFor(() => expect(result.current.status.delivery).toBe("idle"))
  expect(result.current.status.pending).toBe(1)
  expect(result.current.value.title).toBe("After")
  expect(onCanonization).not.toHaveBeenCalled()

  rerender({ currentCanon: canon("After", 1) })
  await waitFor(() => expect(result.current.status.pending).toBe(0))
  expect(onCanonization).toHaveBeenCalledExactlyOnceWith(ok(undefined))
})
```

This example uses the framework-independent root from `headcanon/react`. Its sender returns a Result containing an accepted stamp or a public refusal. The Next factory in [React usage](react.md) adapts generated Server Action outcomes for you.

The test's refetch deliberately delivers no data; `rerender` supplies the new canon. In your application, the loader or query refetch must deliver it. Clean up rendered roots after each test so pending actions and subscriptions cannot affect the next test.

Add cases for the behavior your UI exposes:

- A local refusal leaves the value unchanged and never calls `send`.
- A server refusal removes the prediction and shows the public refusal.
- An ordinary delivery error makes delivery uncertain. `retryDelivery()` resends the same mutation ID, and later queued mutations wait while the head remains uncertain.
- A sender that throws `new TerminalDeliveryError({ kind: "stale-client" })` settles the receipt with that failure and never makes delivery uncertain. Assert the "Refresh to update" prompt your UI shows.
- New canon causes a pending predictor to refuse during replay. Assert the conflict and the resulting visible value.
- Canon stays behind an accepted stamp. The root eventually stalls; `retryRefresh()` requests data without sending the mutation again.

Use fake timers for wait limits and retry delays, advancing them inside React's `act`. Restore real timers after each test. Avoid waiting real seconds for recovery tests. `receipt.accepted` and `receipt.canonized` resolve to Results; assert their success or error values rather than expecting promise rejection.

## Test remote updates without Ably

The in-memory invalidation adapter is both a subscriber adapter and a publisher. It publishes synchronously, filters by axis, and records each published `{ eventId, axis, revision }` entry.

This test shows that a notification requests a refresh but does not replace the displayed data:

```ts
// lib/notes/remote-updates.test.ts
// @vitest-environment jsdom
import { noteAxis } from "@/lib/notes/protocol"
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { acceptedStamp, defineCanon } from "headcanon"
import { createObservedRoot, useSnapshotRefresh } from "headcanon/react"
import { createInMemoryInvalidationAdapter } from "headcanon/testing"
import { afterEach, expect, it, vi } from "vitest"

afterEach(cleanup)

it("loads canon after an invalidation", async () => {
  const noteId = "00000000-0000-4000-8000-000000000001"
  const axis = noteAxis(noteId)
  const canon = (title: string, revision: number) =>
    defineCanon({
      value: { id: noteId, title },
      revisions: { [axis]: revision },
    })
  const invalidations = createInMemoryInvalidationAdapter()
  const refetch = vi.fn(async () => undefined)
  const useNote = createObservedRoot({
    invalidations,
    refresh: () => useSnapshotRefresh(refetch),
  })
  const { result, rerender } = renderHook(
    ({ currentCanon }) => useNote({ canon: currentCanon }),
    { initialProps: { currentCanon: canon("Before", 0) } }
  )
  const parsed = acceptedStamp({ revisions: { [axis]: 1 } })
  if (!parsed.ok) throw new Error("Invalid test stamp")

  act(() => invalidations.publish("remote-edit", parsed.value))
  await waitFor(() => expect(refetch).toHaveBeenCalledOnce())
  expect(result.current.value.title).toBe("Before")
  expect(invalidations.published).toEqual([
    { eventId: "remote-edit", axis, revision: 1 },
  ])

  rerender({ currentCanon: canon("After", 1) })
  await waitFor(() => expect(result.current.status.freshness).toBe("current"))
  expect(result.current.value.title).toBe("After")
})
```

Use `invalidations.setStatus("unavailable")` to test transport status UI. To exercise polling, wrap the bus with `withPollingFallback`, set a degraded status such as `"unavailable"`, and advance fake timers; the wrapper does not poll while the bus is active. The bus starts active and does not simulate connection gaps, token renewal, or Ably channel attachment. Changing its status alone does not emit a gap. To exercise `withVisibilityRefresh`, replace `document.visibilityState` and dispatch a `visibilitychange` event on `document`.

For the integration in [Realtime updates](realtime.md), test your token endpoint's permission decisions: allow owned note axes, reject other users' axes, and reject a mixed request containing even one unauthorized axis. The application passes approved axes to `createAblyAxisTokenRequest`; `createAblyAxisInvalidations` handles the browser's token handshake. Application tests do not need to recreate channel hashing or capability parsing.

## Verify custom adapters

Contract suites are for code that implements or wraps an adapter. You do not need to rerun Headcanon's reference adapters in every application.

Each verifier registers Vitest tests. Call it at the top level of a test file, outside `it` or a hook. To see the authority and invalidation contracts run against the reference implementations:

```ts
// test/reference-contracts.test.ts
import {
  createInMemoryInvalidationContractHarness,
  createInMemoryMutationAuthorityContractHarness,
  verifyInvalidationContract,
  verifyMutationAuthorityContract,
} from "headcanon/testing/contracts"

verifyMutationAuthorityContract(
  createInMemoryMutationAuthorityContractHarness()
)
verifyInvalidationContract(createInMemoryInvalidationContractHarness())
```

For your own adapter, replace the reference harness with one that creates fresh, isolated storage or subscriptions for each case:

| Suite                             | What your harness supplies                                                                                                                                                                                                               | What it checks                                                                                                                                                                                                                                                                                 |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verifyMutationAuthorityContract` | An authority with its default attempt limit and default delivery window; storage initialized to `MUTATION_AUTHORITY_CONTRACT_INITIAL_STATE`; `load`, conditional `writeAxis`, `appendEffect`, `replace`, and receipt inspection methods. | Receipt replay and ID collisions, committed-state screening, atomic stamps, rollback, refusal parsing, contention recovery, and the delivery window: an expired or future-dated envelope runs nothing and records nothing unless a receipt already exists. The suite owns the fixture command. |
| `verifyInvalidationContract`      | `adapter`, `publisher`, `published()` entries, and `settled()` to wait until subscriptions are live.                                                                                                                                     | Axis filtering, one payload per axis, payload fields, and unsubscribe cleanup.                                                                                                                                                                                                                 |
| `verifyRefreshContract`           | A `useRefresh(request)` hook and a completion mode.                                                                                                                                                                                      | Acceptance grace, stalling after two uncovered refreshes, a fresh attempt budget on manual retry, and one refresh of a current root when the page becomes visible.                                                                                                                             |

A custom adapter applies the delivery window with `deliveryAgePolicy` and `checkDeliveryAge` from `headcanon`. Check after the receipt lookup misses and before every attempt, with one clock that also timestamps the receipt. Delete a receipt only after `receiptRetentionMs` on that clock. The contract cannot see your clock, so also test that a delivery waiting on your lock is judged by the clock after the wait.

The exported harness types describe each method. The authority suite uses `MutationAuthorityContractState` and `MUTATION_AUTHORITY_CONTRACT_AXES`; keep fixture writes transactional and make `writeAxis` compare the expected revision. For external resources, arrange test cleanup through your runner's hooks.

A snapshot refresh contract can use the public hook directly:

```ts
// test/snapshot-refresh.test.ts
// @vitest-environment jsdom
import { useSnapshotRefresh } from "headcanon/react"
import { verifyRefreshContract } from "headcanon/testing/react"
import { useCallback } from "react"

verifyRefreshContract({
  name: "snapshot refresh",
  completion: "request",
  useRefresh: (request) =>
    useSnapshotRefresh(useCallback(async () => request(), [request])),
})
```

`useCallback` keeps the refetch function stable across renders, as `useSnapshotRefresh` expects.

Use `completion: "request"` when the refresh promise settles after data delivery. Use `"canon"` for a void request such as `router.refresh()`, where a new canon completes the attempt. The suite always delivers that canon; a real `router.refresh()` that fails reloads the page instead (see [Loading data](loading-data.md#a-failed-router-refresh-reloads-the-page)). The refresh suite installs its own fake timers and unmounts its roots. Its return-to-page case replaces `document.visibilityState` and restores it when the case ends. A custom harness should wrap the supplied request in the actual adapter you want to verify.

## Keep a small browser suite

Hook tests cannot verify that Next delivers new canon or that a real token permits the intended subscription. Test these paths in the running application:

1. Delay a mutation response. Confirm the predicted value appears immediately, stays visible during refresh, and settles when confirmed data arrives.
2. Interrupt delivery after a server commit, then retry. Confirm the write happens once and the recorded outcome is recovered.
3. Edit one note from two authorized sessions. Confirm the second view refreshes after publication. With the owner-only policy in Realtime updates, both sessions must belong to the owner.
4. Disconnect realtime, change data elsewhere, then reconnect. Confirm a gap refresh catches the view up. Test polling separately if enabled.

The repository's own [contributor guide](../CONTRIBUTING.md) lists package and browser test commands. Those commands test Headcanon itself; your application needs its own tests for permissions, storage, and UI behavior.

## Further reading

- [Server setup](server-setup.md) — command stages, outcomes, receipts, and retries.
- [Loading data](loading-data.md) — revisions and canon coverage.
- [React usage](react.md) — lifecycle results, status, and recovery controls.
- [Realtime updates](realtime.md) — publication, authorization, and reconnect behavior.
