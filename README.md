# Headcanon

> headcanon — optimistic mutations for Next.js: believe your writes until canon
> says otherwise.

`@workspace/headcanon` provides a framework-independent protocol entry, a
client-only React entry, and explicit Next client/server bindings for optimistic
mutations. Protocol definitions remain shareable between browser and server
code; `@workspace/headcanon/react` owns the mounted prediction lifecycle without
introducing another projected-state store.

## One complete path

Everything below is one feature: a rename that the UI believes instantly and
canon confirms.

### 1. Define the mutation and protocol once

Keep this definition client-safe and share it between browser and server.

```ts
// domain/notes/protocol.ts
import { defineMutation, defineProtocol } from "@workspace/headcanon"

export const renameNote = defineMutation({
  name: "notes.rename",
  args: renameArgsSchema, // any Standard Schema parser, such as Zod
  predict: (state: NotesState, args) => ok(applyRename(state, args)),
  refusal: renameRefusalSchema, // structured and preserved in receipts
})

export const notesProtocol = defineProtocol({
  id: "myapp.notes.v1",
  mutations: [renameNote],
})
```

### 2. Bind the server command and export the generated Server Action

```ts
// lib/actions/notes/apply.ts
"use server"

import { createDrizzleMutationAuthority } from "@workspace/headcanon/drizzle"
import {
  bindMutation,
  createNextMutationAction,
} from "@workspace/headcanon/next/server"

export const applyNotesMutationAction = createNextMutationAction({
  protocol: notesProtocol,
  actor: requireActor, // derive the trusted actor; it never rides the wire
  authority: createDrizzleMutationAuthority({
    db,
    scope: (actor) => actor.userId,
  }),
  commands: [bindMutation(renameNote, renameNoteCommand)], // screen / admit / execute / repeat-safe finalizeAccepted
  invalidations: notesInvalidationPublisher,
  reportInvalidationFailure,
})
```

### 3. Create the client predicted root from the action

```ts
// domain/notes/use-note-predictions.ts
"use client"

import { createNextPredictedRoot } from "@workspace/headcanon/next/client"

export const useNotePredictions = createNextPredictedRoot({
  protocol: notesProtocol,
  action: applyNotesMutationAction,
  invalidations: axisInvalidations, // omit when this client has no realtime
})
```

### 4. Mount the root over the route's canon and mutate

```tsx
function NoteTitle({ canon }: { canon: Canon<NotesState> }) {
  const { value, mutate } = useNotePredictions({ canon })

  const rename = (title: string) => {
    const result = mutate(renameNote({ noteId: value.focused, title }))
    if (!result.ok) {
      toast.error(copyFor(result.error)) // refused by the local predictor
      return
    }
    return result.value
  }

  // `value` shows a successful rename immediately. The server validates the
  // same intent against authoritative state before committing it.
}
```

### 5. Await only the milestones the caller needs

```ts
const receipt = rename("Chapter Two")
if (!receipt) return

const accepted = await receipt.accepted // authority committed an AcceptedStamp
const canonized = await receipt.canonized // this canon now covers that stamp
```

That configuration supplies one ordered delivery queue with durable mutation
identity; ambiguous-delivery recovery that redelivers the exact envelope;
receipt-deduplicated, contention-retried transactional execution; structured
refusals recovered from duplicate receipts; per-axis cache-tag expiry, route
refresh, and realtime invalidation derived from each accepted stamp; rebase of
pending intent over newer canon; and typed `accepted` and `canonized`
milestones.

### Conventions, not guesses

Headcanon owns conventions only at framework seams it can determine safely. A
generated Next Server Action uses the standard sender adapter; a Next RSC root
uses the App Router refresh carrier with a 250 ms acceptance grace; omitting
client invalidations means no realtime; and the Drizzle and Ably entries expose
their standard adapters. The explicit `send` and `refresh` form remains public
for snapshot carriers, tests, and unusual delivery adapters.

Headcanon never infers application-owned facts: actor identity; screening,
admission, in-transaction authorization, or other authority policy; mutation
semantics and refusal vocabularies; storage axes or guarded version writes;
projection dependencies; storage scope or home; redaction; or external-commit
context. Those decisions stay explicit at the boundary that has enough trusted
context to enforce them.

## Protocol core

- **Revision vectors.** `AxisId`, branded `Revision` values, `RevisionVector`,
  `Canon<State>`, and `AcceptedStamp` model independently advancing streams of
  authoritative state. Their constructors reject malformed external values with
  typed `Result` failures.
- **Canon construction.** `defineCanon({ value, revisions })` brands a loader's
  axis-namespace keys and raw revision integers into a validated, frozen
  `Canon<State>` for the uncached read path — the counterpart of
  `tagVersionedBase` for `"use cache"` loaders. It throws on an invalid revision
  vector, since a loader emitting a malformed coordinate is a data-integrity
  fault rather than an expected boundary.
- **Coverage.** `covers(canon, stamp)` applies the product order: canon covers an
  accepted stamp only when every stamped axis exists at the accepted revision or
  later. Lifecycle code can use that fact to determine when a headcanon has been
  canonized.
- **Typed protocols.** `defineMutation` creates a callable invocation factory that
  retains its stable wire name, Standard Schema parser, and pure predictor.
  `defineProtocol` freezes a name-indexed registry, infers its invocation union,
  and rejects duplicate stable names.
- **Canonical invocation identity.** `canonicalInvocation` combines a protocol ID
  and invocation into RFC 8785 canonical JSON, exact UTF-8 bytes, and a lowercase
  SHA-256 fingerprint. It rejects values outside the supported JSON domain before
  canonicalization and isolates valid input from inherited `toJSON` behavior.
- **Authority execution.** `createNextMutationAction` strictly admits envelopes,
  reparses arguments, and selects one exhaustive definition-keyed command before
  entering receipt authority. The authority adapter owns receipt scope,
  transactional attempts, contention retry, and attempt-local stamp lifetimes;
  commands own application admission, execution, and repeat-safe accepted
  projections.
- **Invalidation vocabulary.** The framework-independent entry defines singleton
  axis invalidations, subscribers, and publishers without pulling React or Next
  into the protocol graph.
- **Shared-entry safety.** The dependency gate walks everything reachable from the
  protocol and React client entries and rejects Node built-ins, server-only
  modules, database and server-framework dependencies, and environment or secret
  access.

## React predicted root

`createPredictedRoot` binds a protocol, delivery function, refresh carrier, and
optional invalidation adapter once, then returns a hook that accepts the latest
complete `Canon<State>`. Its reducer-form
`useOptimistic` projection accumulates pending intent, rebases over newer canons,
and treats an accepted mutation as identity as soon as canon covers its complete
revision vector.

Each successful local prediction returns a `MutationReceipt` with independent
`accepted` and `canonized` promises. Both promises resolve with `Result` and never
reject. The mounted root owns one ordered delivery queue, preserves uncertain
envelopes, josses replay-refused predictions after commit, and resolves unsettled
receipts if the root unmounts.

When delivery becomes uncertain, `retryDelivery()` redelivers the queue head
with the exact same envelope and mutation ID. Automatic reconnect policy remains
outside the React core.

Accepted mutations remain predicted while the carrier catches up. Router-carried
canons receive 250 ms for the Server Action's RSC payload before the package
requests `router.refresh()`; snapshot carriers refetch immediately. A dedicated
refresh transition coalesces requests and retries one uncovered refresh after one
second. Two completed uncovered attempts produce a typed `behind`,
`missing-axis`, or `refresh-error` stall while leaving accepted predictions
mounted. `retryRefresh()` and genuinely fresher invalidations reset that budget.
Promise-returning adapters complete from their promise; void carriers such as
`router.refresh()` consume an attempt only when the root receives the next canon.

`createObservedRoot` is the watch-only specialization. It exposes the canonical
value, freshness and invalidation status, and `retryRefresh()` without a mutation
surface. Predicted and observed roots share the same subscriptions, monotonic
invalidation comparison, refresh coalescing, and stall state machine.

Calls made in the same event synchronously pre-check against the same rendered
projection. If later same-tick intent becomes invalid only after an earlier
prediction, it is jossed during reducer replay and is never delivered. Headcanon
does not maintain the synchronous shadow projection that would be required to
turn that case into an immediate local refusal.

Use `createNextPredictedRoot` from `@workspace/headcanon/next/client` when a raw
Server Action may throw Next navigation or authorization control flow. The
binding runs `unstable_rethrow` before ordinary thrown requests become uncertain
delivery. The same entry owns `useRouterRefresh`; snapshot refresh remains in
`@workspace/headcanon/react`.

The server binding derives one bounded SHA-256 cache tag per axis,
`tagVersionedBase` fails closed above Next's 128-tag ceiling, and
`createNextMutationAction` finalizes accepted stamps with `updateTag`, one
shared-event invalidation publication, and server `refresh()`. The separately
named external-commit helpers preserve the Server Action versus Route Handler
context distinction. Each binding requires an application-owned failure
reporter; publication rejection and timeout are recorded there without changing
the accepted outcome.

## Ably invalidations

`@workspace/headcanon/ably/server` turns one accepted stamp into a singleton
message per axis through an application-supplied Ably REST client. Server and
client share the deployment-scoped SHA-256 channel derivation from
`@workspace/headcanon/ably/channels`; payload parsing admits only `eventId`,
`axis`, and a valid revision.

`@workspace/headcanon/ably/client` aggregates every mounted root's observed
axes, requests one exact subscribe-only capability through Ably `authorize()`,
and attaches new channels only after authorization succeeds. Axis-set changes
and recovered connections enter `reauthorizing`; authorization, attachment, or
connection failure enters `unavailable`. A successful attachment or connection
recovery requests one coalesced refresh to close the delivery gap.

Viewer policy and token issuance remain application-owned. The application's
auth callback must derive permission from trusted viewer and tenant context; it
must not grant an axis merely because the browser requested its channel. The
128-axis contract fixture measures a 14,081-byte capability JSON claim under the
`production` namespace, so adopters can choose native Ably Tokens when a JWT or
header representation would be impractical.

## Contract fixtures

The `@workspace/headcanon/testing` entry ships in-memory authority and
invalidation adapters. The authority provides isolated transactional state,
receipt deduplication, collision detection, terminal-rejection savepoints, and
controllable contention reruns. The invalidation bus fans accepted vectors into
singleton per-axis entries and follows subscription lifetimes.

`verifyMutationAuthorityContract`, `verifyInvalidationContract`, and
`verifyRefreshContract` are reusable black-box suites. Production Drizzle, Ably,
router-shaped, and snapshot-shaped adapters supply harnesses and run the same
behavioral contracts rather than duplicating synchronization assertions.

## Drizzle/Postgres authority

`@workspace/headcanon/drizzle` exports `createDrizzleMutationAuthority`,
`throwMutationContention`, the cycle-safe `matchesPostgresError` matcher, and the
`DrizzleMutationTx` helper type. The matcher lets application-specific
contention rules select a SQLSTATE and optional constraint without reimplementing
wrapped `cause` traversal. The receipt
table itself is published from the dependency-minimal
`@workspace/headcanon/drizzle-schema` entry (drizzle-orm only), so an adopter can
add it to their Drizzle schema — and let `drizzle-kit` scan it — without the
authority graph being pulled into schema tooling. Include the table in the
adopter's schema so its normal migration workflow owns deployment; the equivalent
baseline SQL is checked in at `drizzle/0000_headcanon_mutation_receipts.sql` for
migration review and fixtures.

Commands infer their context when registered through `createNextMutationAction`.
When a command or Store needs an explicit transaction type, use
`DrizzleMutationTx<typeof db>` rather than hand-deriving it from the client type.

The adapter requires an interactive Postgres Drizzle client: for Neon, use the
WebSocket `Pool` integration rather than the HTTP query client. It acquires a
transaction-scoped receipt identity lock before application work, runs each
command attempt in a nested Drizzle transaction/savepoint, and retries bounded
contention. Expected rejections must cross the receipt boundary through the
caller's `parseRejection`; malformed stored outcomes fail closed.

Guarded application writes call `throwMutationContention()` when their
compare-and-swap affects no row. That aborts the outer attempt, discards its
domain writes and stamp, and reruns the complete command from current state.
Unexpected exceptions still propagate without a receipt.

The real-Postgres contract suite runs when `HEADCANON_TEST_DATABASE_URL` or
`DATABASE_URL` is available. It creates a unique schema, proves receipt/domain
atomicity, concurrent deduplication, savepoint rejection, attempt-local stamps,
and SQLSTATE serialization retry, then drops the schema.
