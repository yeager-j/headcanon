import type { StandardSchemaV1 } from "@standard-schema/spec"

/**
 * Parses a stored refusal or result with the schema that defines it, so a
 * replayed value is the same public value the command returned.
 * @param label Names the value in errors, such as `"Mutation refusal"`.
 * @throws Error when the schema validates asynchronously or rejects the value.
 */
export function parseStoredValue<Value>(
  schema: StandardSchemaV1,
  value: unknown,
  label: string
): Value {
  const parsed = schema["~standard"].validate(value)
  if ("then" in parsed) {
    throw new Error(`${label} codecs must validate synchronously`)
  }

  if (parsed.issues) throw new Error(`Invalid stored ${label.toLowerCase()}`)
  return parsed.value as Value
}
