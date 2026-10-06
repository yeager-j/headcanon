# Headcanon

> headcanon — optimistic mutations for Next.js: believe your writes until canon
> says otherwise.

```sh
npm install headcanon
```

`next` and `react` are required peers. The other peers are optional and needed
only by the entries that use them: `ably` for `headcanon/ably/*`, `drizzle-orm`
for `headcanon/drizzle` and `headcanon/drizzle-schema`, `vitest` for
`headcanon/testing/contracts`, and `vitest` with `@testing-library/react` for
`headcanon/testing/react`. `headcanon/testing` needs no optional peer.

`headcanon` provides a framework-independent protocol entry, a
client-only React entry, and explicit Next client/server bindings for optimistic
mutations. Protocol definitions remain shareable between browser and server
code; `headcanon/react` owns the mounted prediction lifecycle without
introducing another projected-state store.

## One complete path

Everything below is one feature: a rename that the UI believes instantly and
canon confirms.

### 1. Define the mutation and protocol once

Keep this definition client-safe and share it between browser and server.

```ts
// domain/notes/protocol.ts
import { defineMutation, defineProtocol } from "headcanon"

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

import { createDrizzleMutationAuthority } from "headcanon/drizzle"
import { bindMutation, createNextMutationAction } from "headcanon/next/server"

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

import { createNextPredictedRoot } from "headcanon/next/client"
import { createPredictedRootContext } from "headcanon/react"

const useNotePredictions = createNextPredictedRoot({
  protocol: notesProtocol,
  action: applyNotesMutationAction,
  invalidations: axisInvalidations, // omit when this client has no realtime
  recoveryListeners: {
    onDeliveryUncertain({ retry }) {
      return showReconnectNotice({ retry })
    },
    onFreshnessStalled({ retry, reason, missingAxes }) {
      return showRefreshNotice({ retry, reason, missingAxes })
    },
    onConflict(conflict) {
      reportRolledBackPrediction(conflict)
    },
  },
})

export const NoteRoot = createPredictedRootContext(useNotePredictions, {
  name: "NoteRoot",
})
```

### 4. Mount one root over the route's canon and mutate from descendants

```tsx
function NoteSurface({ canon }: { canon: Canon<NotesState> }) {
  return (
    <NoteRoot.Provider canon={canon}>
      <NoteTitle />
    </NoteRoot.Provider>
  )
}

function NoteTitle() {
  const { value, mutate } = NoteRoot.useRoot()

  const rename = (title: string) => {
    return mutate(renameNote({ noteId: value.focused, title }), {
      onPrediction(result) {
        if (!result.ok) toast.error(copyFor(result.error))
      },
      onAcceptance(result) {
        if (!result.ok && result.error.kind === "domain") {
          toast.error(copyFor(result.error.error))
        }
      },
      onCanonization(result) {
        if (result.ok) analytics.track("note-canonized")
      },
    })
  }

  // `value` shows a successful rename immediately. The server validates the
  // same intent against authoritative state before committing it.
}
```

### 5. Await only the milestones the caller needs

```ts
const result = rename("Chapter Two")
if (!result.ok) return

const accepted = await result.value.accepted // authority committed an AcceptedStamp
const canonized = await result.value.canonized // this canon now covers that stamp
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

- **Revision vectors.** `AxisId` (any non-empty string), branded `Revision`
  values, `RevisionVector`, `Canon<State>`, and `AcceptedStamp` model
  independently advancing streams of authoritative state. `RevisionVector` is
  opaque: read it with `revisionAt` and `revisionEntries`, never by indexing,
  because axis strings may collide with `Object.prototype` members. The parsers
  `revision`, `revisionVector`, and `acceptedStamp` reject malformed external
  values with typed `Result` failures; an outer parser nests an inner parser's
  error under `error`. An accepted stamp comes only from a stamp accumulator
  inside authority or from the `acceptedStamp` parser at a wire or storage
  boundary.
- **Canon construction.** `defineCanon({ value, revisions })` parses a loader's
  raw axis keys and revision integers into a validated, frozen `Canon<State>`
  for the uncached read path. `tagVersionedBase` in `headcanon/next/server`
  runs the same parse for `"use cache"` loaders and also tags the cache entry.
  Both throw on an invalid revision vector, since a loader emitting a malformed
  coordinate is a data-integrity fault rather than an expected boundary.
- **Coverage.** `covers(canon.revisions, stamp.revisions)` applies the product
  order: canon covers an accepted stamp only when every stamped axis exists at
  the accepted revision or later. Lifecycle code can use that fact to determine
  when a headcanon has been canonized.
- **Typed protocols.** `defineMutation` creates a callable invocation factory that
  retains its stable wire name, Standard Schema parser, and pure predictor, and
  keeps a deeply frozen copy of each invocation's arguments. Arguments are in
  parsed form: the factory takes the schema's output, the predictor and the
  server command receive that same value, and authority parses it again and
  refuses it as `invalid-arguments` unless parsing leaves it unchanged. A schema
  whose output is not a valid input is a compile error. `defineProtocol` freezes
  the mutation list, infers its invocation union, requires every mutation to
  predict one state type (for inline tuples and predeclared arrays alike), and
  rejects duplicate stable names.
- **Canonical invocation identity.** `canonicalInvocation` combines a protocol ID
  and invocation into RFC 8785 canonical JSON, exact UTF-8 bytes, and a lowercase
  SHA-256 fingerprint, and returns the isolated invocation that identity
  describes; authority passes those arguments to commands. It rejects values
  outside the supported JSON domain before canonicalization and isolates valid
  input from inherited `toJSON` behavior.
- **Authority execution.** `createNextMutationAction` strictly admits envelopes,
  reparses arguments, and selects one exhaustive definition-keyed command before
  entering receipt authority. The authority adapter owns receipt scope,
  transactional attempts, contention retry, and attempt-local stamp lifetimes,
  and supplies the `preflight` executor that screening reads committed state
  through; commands own application admission, execution, and repeat-safe
  accepted projections. A command attempt is accepted, `refused` (a public
  refusal, recorded and replayed), or `denied` (private); the terminal outcome
  uses the same names. The generated action returns a denial, from screening
  or from a recorded admission, as `ok({ kind: "denied" })` with no reason. It
  does not throw Next's `forbidden()`, so it needs no `experimental.authInterrupts`
  flag. A command that loses a race calls
  `throwMutationContention()` from `headcanon`, and every adapter reruns it.
- **Invalidation vocabulary.** The framework-independent entry defines singleton
  axis invalidations, subscribers, publishers, and the one meaning of each
  `InvalidationStatus` (with `isDegradedInvalidationStatus` for `disabled`,
  `reauthorizing`, and `unavailable`) without pulling React or Next into the
  protocol graph. An adapter's `initialStatus` is read at subscribe time.
  `createLazyInvalidationAdapter` wraps a transport that is created
  asynchronously, for example after a dynamic import of the Ably SDK: it
  reports `reauthorizing` until the transport is ready and then forwards the
  transport's own status. `withPollingFallback` wraps a transport and, while
  it is degraded, reports `polling` and signals a subscription gap at a fixed
  interval, so the root refreshes through its usual carrier.
- **Shared-entry safety.** The dependency gate walks everything reachable from the
  protocol and React client entries and rejects Node built-ins, server-only
  modules, database and server-framework dependencies, and environment or secret
  access.

## React predicted root

`createPredictedRoot` binds a protocol, delivery function, refresh carrier, and
optional invalidation adapter once, then returns a hook that accepts the latest
complete `Canon<State>`. The rendered value is every live prediction folded over
that canon in invocation order: it rebases over newer canons, and it treats an
accepted mutation as identity as soon as canon covers its complete revision
vector, in the same render that delivers that canon. The root's mutation ledger
is the one authority for this: the value, `status`, and `conflicts` all read it
through `useSyncExternalStore`.

Each call to that hook mounts an independent root with its own queue, receipt
ledger, and subscription lifetime. `createPredictedRootContext` turns one
generated hook into a provider plus `useRoot` consumer hook so every descendant
shares the same mounted root. The provider's lifetime is the root's lifetime;
key it by an application-owned aggregate identity if one component instance can
switch between logical aggregates. Direct hook mounting remains useful for
single-owner surfaces and tests.

Each successful local prediction returns a `MutationReceipt` with independent
`accepted` and `canonized` promises. Both promises resolve with `Result` and never
reject. The mounted root owns one ordered delivery queue, preserves uncertain
envelopes, josses replay-refused predictions after commit, and resolves unsettled
receipts if the root unmounts.

`mutate` accepts optional `onPrediction`, `onAcceptance`, and `onCanonization`
listeners. Each listener receives the same `Result` represented by that stage,
so the application chooses its own feedback, navigation, and telemetry policy
without collapsing the lifecycle into generic success and error callbacks.
Factory-level listeners provide defaults; a mutate call overrides only the
stages it supplies. Delivery uncertainty remains root status because it is a
queue condition, not a terminal mutation stage.

Each delivery attempt holds a React Action open, so canon that rides back with
the response cannot commit before its acceptance is recorded. React holds every
other transition while an Action is open, so the hold is bounded: after
`DELIVERY_WAIT_MS` (10 seconds) without an answer, delivery becomes uncertain
and the Action ends. An ordinary throw from `send` also makes delivery
uncertain. While the head is uncertain, the queue waits and every prediction
stays rendered. `retryDelivery()` redelivers the queue head with the exact same
envelope and mutation ID. An answer that arrives late, to the first attempt or
to a retry, still settles the mutation: the authority deduplicates by mutation
ID, so every attempt gets the same answer. Automatic reconnect policy remains
outside the React core.

A `send` adapter reports the authority's other answers with two error classes.
`RetryableDeliveryError` means the authority stored no receipt (exhausted
contention): the root redelivers the same envelope on a bounded backoff.
`TerminalDeliveryError` means the answer is final but is not a domain refusal:
a private denial (`denied`) or an executor refusal of the envelope itself
(`undeliverable`, for example arguments that do not parse). The root settles
both receipt milestones with that failure and never retries it.

Accepted mutations remain predicted while the carrier catches up, however long
that takes, including when the carrier stalls. Router-carried
canons receive 250 ms for the Server Action's RSC payload before the package
requests `router.refresh()`; snapshot carriers refetch immediately. A dedicated
refresh transition coalesces requests and retries one uncovered refresh after one
second. Two completed uncovered attempts produce a typed `behind`,
`missing-axis`, or `refresh-error` stall while leaving accepted predictions
mounted; `status.stallReason` exists only while `status.freshness` is
`stalled`. `retryRefresh()`, a new acceptance, and genuinely fresher
invalidations reset that budget. A subscription gap (`onSubscriptionGap`) is a
requirement too: only a successful refresh that started after the gap closes
it, so a failed one leaves the root short of `current` and subject to the same
budget, stall, and `retryRefresh()`. Every status field describes the canon
of the render that reads it: a render that delivers covering canon reports
`current` with empty `missingAxes` in that same render.
Promise-returning adapters complete from their promise; void carriers such as
`router.refresh()` consume an attempt only when the root receives a canon whose
state value (by identity) or revisions changed, so re-rendering with the same
canon, or with a rebuilt wrapper around the same state, does not.

`recoveryListeners` map uncertain delivery, stalled freshness, and newly recorded
replay conflicts onto application-owned effects. Factory listeners provide
defaults, while a mounted root may override individual conditions for
aggregate-specific identity or copy. Degraded-state listeners may return cleanup
that runs on recovery or unmount; conflict listeners run once per mutation ID
during the root's mounted lifetime. Headcanon decides when those conditions are
active and supplies retry controls; the application still decides whether to
show a toast, banner, reconnect control, telemetry event, or nothing.

`createObservedRoot` is the watch-only specialization. It exposes the canonical
value, freshness and invalidation status, and `retryRefresh()` without a mutation
surface. Predicted and observed roots share the same subscriptions, monotonic
invalidation comparison, refresh coalescing, and stall state machine.

Calls made in the same event synchronously pre-check against the same rendered
projection. If later same-tick intent becomes invalid only after an earlier
prediction, it is jossed during replay and is never delivered. `conflicts`
keeps the 50 most recent replay conflicts. Headcanon
does not maintain the synchronous shadow projection that would be required to
turn that case into an immediate local refusal.

Use `createNextPredictedRoot` from `headcanon/next/client` when a raw
Server Action may throw Next navigation or authorization control flow. The
binding runs Next's `unstable_rethrow` on every delivery throw first: a
`redirect()`, `notFound()`, `forbidden()`, or `unauthorized()` signal settles the
mutation as `delivery-cancelled` and reaches Next instead of becoming uncertain
delivery. Its `action` form maps the generated action's outcomes: contention is
retryable, while a denial or any other executor error is a terminal
`TerminalDeliveryError`. Both forms accept every `createPredictedRoot` option
and default `refresh` to the App Router carrier. The same entry owns
`useRouterRefresh`; snapshot refresh remains in `headcanon/react`.

The server binding derives one bounded SHA-256 cache tag per axis (hashed the
same way as the Ably channel name, so `axisCacheTag` is async),
`tagVersionedBase` parses a `"use cache"` loader's `{ value, revisions }` into a
canon and fails closed above Next's 128-tag ceiling, and
`createNextMutationAction` finalizes accepted stamps with `updateTag`, one
shared-event invalidation publication, and server `refresh()`. It runs the
command's `finalizeAccepted` projection first, so the projection exists before
any reader is told to reload; if the projection throws, the action still
invalidates the commit and then rethrows. The separately
named external-commit helpers preserve the Server Action versus Route Handler
context distinction. Each binding requires an application-owned failure
reporter; publication rejection and timeout are recorded there without changing
the accepted outcome.

## Ably invalidations

`headcanon/ably/server` turns one accepted stamp into a singleton
message per axis and sends them through Ably REST batch publish (at most 100
channels per request). If Ably rejects a request or refuses a channel, the
publication rejects with `AblyInvalidationPublicationError`, whose `failures`
name exactly the axes that were not published; the other axes were. Server and
client share the deployment-scoped SHA-256 channel derivation from
`headcanon/ably/channels`. Both factories parse `namespace` at construction and
throw on an invalid one (segments of letters, digits, `_`, `.`, or `-` joined by
single colons); it is never trimmed or rewritten. Hashing keeps channel names
bounded and channel-safe; it does not hide the axis, which every payload
carries in clear next to `eventId` and a valid revision. Payload parsing admits
only those three fields, and a payload whose axis does not match its channel is
dropped with an `axis-channel-mismatch` diagnostic.

`headcanon/ably/client` aggregates every mounted root's observed
axes, requests one exact subscribe-only capability through Ably `authorize()`,
and attaches new channels only after authorization succeeds. It requests a new
token only when the axis set changes or Ably reports an auth error; connection
recovery reuses the current token, and an empty set requests nothing. Status is
derived from the connection state, each desired channel's state, and the last
reconciliation: a down connection, a `failed` or `suspended` channel, or a
failed authorization or attachment reports `unavailable`; a channel not yet
attached reports `reauthorizing`; otherwise `active`. With no subscriptions it
reports `reauthorizing` (or `unavailable` while disconnected). `retry()`
re-attaches every desired channel that is not attached. Each new subscription
gets one `onSubscriptionGap` once its axes deliver, even on channels that were
already attached; connection recovery and channel continuity loss (`attached`
or `update` with `resumed: false`) request it again. Unsubscribing releases
unobserved channels without waiting for authorization.

Viewer policy and token issuance remain application-owned. The application's
auth callback must derive permission from trusted viewer and tenant context; it
must not grant an axis merely because the browser requested its channel. The
128-axis contract fixture measures a 14,081-byte capability JSON claim under the
`production` namespace, so adopters can choose native Ably Tokens when a JWT or
header representation would be impractical.

## Test doubles and contract suites

Three entries serve tests. Each states what it needs.

| Entry                         | Exports                                                                                                       | Needs                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `headcanon/testing`           | `createInMemoryMutationAuthority`, `createInMemoryInvalidationAdapter`                                        | Nothing: any test runner, a script, or a server module.  |
| `headcanon/testing/contracts` | `verifyMutationAuthorityContract`, `verifyInvalidationContract`, their harness types, and in-memory harnesses | `vitest`, in the `node` environment.                     |
| `headcanon/testing/react`     | `verifyRefreshContract`, `RefreshContractHarness`                                                             | `vitest`, `@testing-library/react`, and a DOM (`jsdom`). |

The in-memory authority follows the Drizzle adapter's rules: receipts keyed by
actor scope and mutation ID, one execution at a time per key while different
keys interleave, a `preflight` reader that sees only committed state, refusals
that need the request's `parseRefusal`, and a rerun when a command throws
`MutationContentionError`. An attempt that wrote state commits only if no other
commit landed since it began; otherwise it reruns. `contendNext(update)` commits
`update` during the next attempt so a test can make that attempt lose a race.
It passes to `createNextMutationAction` as is. The invalidation bus fans
accepted vectors into singleton per-axis entries and follows subscription
lifetimes.

Call a `verify*Contract` function at the top level of a vitest file. The
authority contract owns its fixture command and drives it through
`executePreparedMutation`; a harness supplies only the adapter and the storage
its transactions reach (`load`, a compare-and-set `writeAxis`, `appendEffect`,
`replace`, and receipt counts). The invalidation contract checks the adapter
alone. Production Drizzle, Ably, router-shaped, and snapshot-shaped adapters
run these same suites.

## Drizzle/Postgres authority

`headcanon/drizzle` exports `createDrizzleMutationAuthority`, the cycle-safe
`matchesPostgresError` matcher, and the `DrizzleMutationTx` helper type. The
matcher lets application-specific contention rules (`isContentionError`) select
a SQLSTATE and optional constraint without reimplementing wrapped `cause`
traversal. The receipt
table itself is published from the dependency-minimal
`headcanon/drizzle-schema` entry (drizzle-orm only), so an adopter can
add it to their Drizzle schema — and let `drizzle-kit` scan it — without the
authority graph being pulled into schema tooling. Include the table in the
adopter's schema so its normal migration workflow owns deployment; the equivalent
baseline SQL is checked in at `drizzle/0000_headcanon_mutation_receipts.sql` for
migration review and fixtures, and a test fails if it drifts from the table
definition. Receipts are written once; `created_at` is indexed for pruning.

Commands infer their context when registered through `createNextMutationAction`.
When a command or Store needs an explicit transaction type, use
`DrizzleMutationTx<typeof db>` rather than hand-deriving it from the client type.

The adapter requires an interactive Postgres Drizzle client: for Neon, use the
WebSocket `Pool` integration rather than the HTTP query client. It acquires a
transaction-scoped receipt identity lock before application work, runs each
command attempt in a nested Drizzle transaction/savepoint, and retries bounded
contention. Refusals cross the receipt boundary only through the request's
`parseRefusal`, which `createNextMutationAction` derives from each mutation's
refusal schema; without one, a refusal throws instead of being recorded or
replayed. Malformed stored outcomes fail closed.

Every attempt runs at READ COMMITTED, whatever the database default. Under
REPEATABLE READ or SERIALIZABLE the transaction snapshot is taken by the lock
statement itself, before the lock is granted, so a duplicate delivery waiting
on the lock could not see the receipt its twin had just committed and would run
the command again. The adapter therefore takes no isolation option.

Guarded application writes call `throwMutationContention()` (from `headcanon`)
when their compare-and-swap affects no row. That aborts the outer attempt,
discards its domain writes and stamp, and reruns the complete command from
current state. Unexpected exceptions still propagate without a receipt.

The real-Postgres contract suite runs when `HEADCANON_TEST_DATABASE_URL` or
`DATABASE_URL` is available. It creates a unique schema and runs the authority
contract once for each database default isolation level (read committed,
repeatable read, serializable): receipt/domain atomicity, concurrent
deduplication, savepoint rollback of refusals, attempt-local stamps, preflight
isolation, and fail-closed refusal parsing. It also checks SQLSTATE
serialization retry, then drops the schema.
