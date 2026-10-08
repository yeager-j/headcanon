// `headcanon`: the framework-free API an application uses to define its
// protocol, build canon, and choose an invalidation transport. Exports with
// no use of their own name the types that public signatures in this and the
// other entries use. Adapter internals (the authority receipt protocol,
// payload parsers, and contract suites) are not exported.
export {
  acceptedStamp,
  axisId,
  defineCanon,
  type AcceptedStamp,
  type AcceptedStampValidationError,
  type AxisId,
  type Canon,
  type Revision,
  type RevisionVector,
} from "./core/revisions"
export {
  defineAxis,
  type AxisFamily,
  type AxisKeyError,
} from "./core/axis-family"
export {
  defineMutation,
  defineProtocol,
  type AnyMutationDefinition,
  type MutationContext,
  type MutationDefinition,
  type MutationErrorOf,
  type MutationInvocation,
  type MutationRefusalOf,
  type ProtocolDefinition,
  type ProtocolInvocation,
} from "./core/protocol"
export {
  type MutationEnvelope,
  type MutationExecutorError,
  type MutationTerminalOutcome,
  type ProtocolIdentity,
} from "./core/authority"
export {
  createNoRealtimeInvalidationAdapter,
  withPollingFallback,
  withVisibilityRefresh,
  type InvalidationAdapter,
  type InvalidationPublicationFailure,
  type InvalidationPublicationFailureReporter,
  type InvalidationPublisher,
  type InvalidationStatus,
  type PollingFallbackOptions,
  type RetryableInvalidationAdapter,
} from "./core/invalidation"

// Diagnostics: read a canon's revisions while debugging coverage.
// Application code does not need them. See docs/loading-data.md, "Know when
// canon confirms a mutation".
export { covers, revisionAt, revisionEntries } from "./core/revisions"
