// `headcanon/server`: the binder that types commands and the outcomes they
// return. It loads no framework, so a command module imports in any runtime.
export {
  throwMutationContention,
  type StampAccumulator,
} from "../core/authority"
export {
  createMutationBinder,
  type CommandChecks,
  type MutationBinder,
  type MutationBinderIdentity,
  type MutationBinding,
  type MutationCommand,
  type OperationBinding,
  type OperationCommand,
} from "./binder"
export {
  acceptMutation,
  acceptOperation,
  allowAdmission,
  allowMutation,
  allowMutationScreening,
  allowScreening,
  denyMutation,
  refuseMutation,
  type MutationAdmission,
  type MutationCommandDecision,
  type MutationScreening,
  type OperationAcceptance,
  type OperationCommandDecision,
} from "./outcomes"
