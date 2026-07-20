# Headcanon

> headcanon — optimistic mutations for Next.js: believe your writes until canon
> says otherwise.

`@workspace/headcanon` is the client-safe protocol core for optimistic mutations.
It describes authoritative state as canon, gives pending writes a stable typed
invocation, and provides the revision and receipt-identity primitives that later
lifecycle layers use to reconcile a prediction with the server's answer. The
package is framework-independent at this layer, so the same protocol definitions
can be shared by browser and server code.

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
  public entry point and rejects Node built-ins, server-only modules, database and
  server-framework dependencies, and environment or secret access.

This package currently contains the P0a protocol foundation only. React bindings,
server execution, receipt storage, replay coordination, and application
integration belong to later Headcanon milestones.
