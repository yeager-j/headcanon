import type { StandardSchemaV1 } from "@standard-schema/spec"

/**
 * Parses a stored refusal with its mutation's refusal schema, so a replayed
 * refusal is the same public value the command returned.
 * @throws Error when the schema validates asynchronously or rejects the value.
 */
export function parseMutationRefusal<Refusal>(
  schema: StandardSchemaV1,
  value: unknown
): Refusal {
  const parsed = schema["~standard"].validate(value)
  if ("then" in parsed) {
    throw new Error("Mutation refusal codecs must validate synchronously")
  }

  if (parsed.issues) throw new Error("Invalid stored mutation refusal")
  return parsed.value as Refusal
}
