# Headcanon

> headcanon — optimistic mutations for Next.js: believe your writes until canon
> says otherwise.

`@workspace/headcanon` provides a framework-independent protocol entry and a
client-only React entry for optimistic mutations. Protocol definitions remain
shareable between browser and server code; `@workspace/headcanon/react` owns the
mounted prediction lifecycle without introducing another projected-state store.

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
- **Shared-entry safety.** The dependency gate walks everything reachable from the
  protocol and React client entries and rejects Node built-ins, server-only
  modules, database and server-framework dependencies, and environment or secret
  access.

## React predicted root

`createPredictedRoot` binds a protocol and delivery function once, then returns a
hook that accepts the latest complete `Canon<State>`. Its reducer-form
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

Calls made in the same event synchronously pre-check against the same rendered
projection. If later same-tick intent becomes invalid only after an earlier
prediction, it is jossed during reducer replay and is never delivered. Headcanon
does not maintain the synchronous shadow projection that would be required to
turn that case into an immediate local refusal.

The `send` seam receives framework-classified delivery. Until the Next client
binding lands, callers must not pass a raw Server Action whose throws may include
Next navigation control flow; an ordinary throw at this seam is deliberately
classified as uncertain delivery.

Refresh coordination, invalidation adapters, server execution, receipt storage,
and application integration belong to later Headcanon milestones.
