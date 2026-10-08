// `headcanon/server`: the binder that types commands and the outcomes they
// return. It loads no framework, so a command module imports in any runtime.
export { throwMutationContention } from "../core/authority"
export {
  createMutationBinder,
  type MutationBinder,
  type MutationBinderIdentity,
  type MutationBinding,
  type MutationCommand,
} from "./binder"
export {
  acceptMutation,
  allowAdmission,
  allowMutation,
  allowMutationScreening,
  allowScreening,
  denyMutation,
  refuseMutation,
  type MutationAdmission,
  type MutationCommandDecision,
  type MutationScreening,
} from "./outcomes"
