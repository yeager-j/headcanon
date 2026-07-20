# Headcanon

> headcanon — optimistic mutations for Next.js: believe your writes until canon
> says otherwise.

`@workspace/headcanon` provides a framework-independent protocol entry, a
client-only React entry, and explicit Next client/server bindings for optimistic
mutations. Protocol definitions remain shareable between browser and server
code; `@workspace/headcanon/react` owns the mounted prediction lifecycle without
introducing another projected-state store.

## Protocol core

- **Revision vectors.** `AxisId`, branded `Revision` values, `RevisionVector`,
  `Canon<State>`, and `AcceptedStamp` model independently advancing streams of
  authoritative state. Their constructors reject malformed external values with
  typed `Result` failures.
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
- **Authority execution.** `createMutationExecutor` strictly admits envelopes,
  reparses arguments, computes receipt identity, and dispatches through an
  exhaustive handler registry. The authority adapter owns receipt scope,
  transactional attempts, contention retry, and attempt-local stamp lifetimes;
  handlers receive only their transaction, parsed arguments, trusted actor, and
  stamp accumulator.
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
`createNextMutationExecutor` finalizes accepted stamps with `updateTag`, one
shared-event invalidation publication, and server `refresh()`. The separately
named external-commit helpers preserve the Server Action versus Route Handler
context distinction.

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

Postgres receipt storage, concrete realtime adapters, and application
integration belong to later Headcanon milestones.
