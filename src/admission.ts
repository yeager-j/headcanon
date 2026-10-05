/**
 * Trust-boundary checks shared by every parser that admits untrusted values.
 *
 * A trustworthy plain record has a plain or null prototype and only
 * string-keyed, enumerable data properties. Reading such a record can never
 * run caller code (no getters, no inherited `toJSON`) and every key is visible
 * to `Object.keys`, so "what was checked" and "what is read" cannot differ.
 * These are fail-closed security checks: keep one copy here.
 */

/** The first reason a value is not a trustworthy plain record. */
export type PlainRecordViolation =
  | { readonly reason: "not-plain-object" }
  | { readonly reason: "symbol-key" }
  | { readonly reason: "non-enumerable-property"; readonly key: string }
  | { readonly reason: "accessor-property"; readonly key: string }

/**
 * Finds the first reason a value is not a trustworthy plain record.
 * @param value Untrusted candidate.
 * @returns The first violation in own-key order, or `undefined` when the value is a trustworthy plain record.
 */
export function plainRecordViolation(
  value: unknown
): PlainRecordViolation | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { reason: "not-plain-object" }
  }

  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    return { reason: "not-plain-object" }
  }

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") return { reason: "symbol-key" }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable) {
      return { reason: "non-enumerable-property", key }
    }
    if (!("value" in descriptor)) return { reason: "accessor-property", key }
  }

  return undefined
}

/**
 * Returns whether a value is a trustworthy plain record.
 * @param value Untrusted candidate.
 * @returns Whether the value has a plain or null prototype and only string-keyed, enumerable data properties.
 */
export function isPlainRecord(
  value: unknown
): value is Record<string, unknown> {
  return plainRecordViolation(value) === undefined
}

/**
 * Returns whether a trustworthy plain record has exactly the given own keys.
 * @param record Record already admitted by {@link isPlainRecord}.
 * @param keys Expected keys, each listed once.
 * @returns Whether the record has every expected key and no other.
 */
export function hasExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[]
): boolean {
  return (
    Reflect.ownKeys(record).length === keys.length &&
    keys.every((key) => Object.hasOwn(record, key))
  )
}
