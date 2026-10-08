import canonicalize from "canonicalize"
import { err, ok, type Result } from "serializable-result"

import { plainRecordViolation } from "./admission"
import type { MutationInvocation } from "./protocol"
import { sha256Hex } from "./sha256"

/**
 * The exact receipt identity material for one parsed protocol invocation.
 *
 * Receipt equality must compare `bytes`; `sha256` exists for indexed lookup and
 * diagnostics and is not, by itself, the equality proof.
 */
export interface CanonicalInvocation {
  /** RFC 8785 JSON represented by `bytes`. */
  readonly json: string
  /** Canonical UTF-8 bytes whose exact equality decides honest redelivery. */
  readonly bytes: Uint8Array
  /** Lowercase SHA-256 fingerprint of `bytes`. */
  readonly sha256: string
}

/**
 * An invocation's receipt identity together with the exact value it describes.
 *
 * `invocation` is an isolated copy of the validated input: null-prototype
 * objects and `toJSON`-free arrays holding the same data. Authority hands its
 * `args` to commands, so what was hashed is what runs.
 */
export interface PreparedCanonicalInvocation<Name extends string, Args> {
  readonly canonical: CanonicalInvocation
  readonly invocation: MutationInvocation<Name, Args>
}

/** A fail-closed input failure while preparing receipt identity. */
export type CanonicalInvocationError = {
  readonly code: "invalid-json-value"
  readonly reason:
    | "undefined"
    | "function"
    | "symbol"
    | "bigint"
    | "non-finite-number"
    | "cyclic"
    | "resource-limit"
    | "class-instance"
    | "invalid-unicode"
    | "symbol-key"
    | "accessor-property"
    | "non-enumerable-property"
    | "unsupported-array-property"
  readonly path: readonly (string | number)[]
}

function hasValidUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false
    }
  }

  return true
}

function invalid(
  reason: CanonicalInvocationError["reason"],
  path: readonly (string | number)[]
): CanonicalInvocationError {
  return { code: "invalid-json-value", reason, path }
}

// Bound the expanded tree, not distinct identities: aliases are valid JSON
// data, but every occurrence contributes to copying and canonical output.
const MAX_CANONICAL_VALUES = 10_000
const MAX_CANONICAL_DEPTH = 100
const MAX_CANONICAL_CHARACTERS = 1_048_576

interface CanonicalBudget {
  remainingValues: number
  remainingCharacters: number
}

function accountCharacters(
  budget: CanonicalBudget,
  count: number,
  path: readonly (string | number)[]
): CanonicalInvocationError | undefined {
  budget.remainingCharacters -= count
  return budget.remainingCharacters < 0
    ? invalid("resource-limit", path)
    : undefined
}

function accountString(
  budget: CanonicalBudget,
  value: string,
  path: readonly (string | number)[]
): CanonicalInvocationError | undefined {
  // Check before JSON.stringify allocates the escaped representation.
  if (value.length > budget.remainingCharacters) {
    return invalid("resource-limit", path)
  }
  return accountCharacters(budget, JSON.stringify(value).length, path)
}

function validateJsonValue(
  value: unknown,
  path: readonly (string | number)[],
  ancestors: WeakSet<object>,
  budget: CanonicalBudget
): CanonicalInvocationError | undefined {
  budget.remainingValues -= 1
  if (budget.remainingValues < 0 || path.length > MAX_CANONICAL_DEPTH) {
    return invalid("resource-limit", path)
  }

  if (value === null || typeof value === "boolean") {
    return accountCharacters(budget, String(value).length, path)
  }

  if (typeof value === "string") {
    const sizeError = accountString(budget, value, path)
    if (sizeError) return sizeError
    return hasValidUnicode(value) ? undefined : invalid("invalid-unicode", path)
  }
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? accountCharacters(budget, JSON.stringify(value).length, path)
      : invalid("non-finite-number", path)
  }
  if (typeof value === "undefined") return invalid("undefined", path)
  if (typeof value === "function") return invalid("function", path)
  if (typeof value === "symbol") return invalid("symbol", path)
  if (typeof value === "bigint") return invalid("bigint", path)

  if (ancestors.has(value)) return invalid("cyclic", path)

  const isArray = Array.isArray(value)
  if (isArray && Object.getPrototypeOf(value) !== Array.prototype) {
    return invalid("class-instance", path)
  }

  const containerError = accountCharacters(budget, 2, path)
  if (containerError) return containerError

  ancestors.add(value)
  try {
    if (isArray) {
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key === "symbol") return invalid("symbol-key", path)
        if (key === "length") continue

        const index = Number(key)
        if (
          !Number.isInteger(index) ||
          index < 0 ||
          index >= value.length ||
          String(index) !== key
        ) {
          return invalid("unsupported-array-property", [...path, key])
        }
      }

      const separatorError = accountCharacters(
        budget,
        Math.max(0, value.length - 1),
        path
      )
      if (separatorError) return separatorError

      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor) return invalid("undefined", [...path, index])
        if (!("value" in descriptor)) {
          return invalid("accessor-property", [...path, index])
        }

        const elementError = validateJsonValue(
          descriptor.value,
          [...path, index],
          ancestors,
          budget
        )
        if (elementError) return elementError
      }
      return undefined
    }

    const violation = plainRecordViolation(value)
    if (violation?.reason === "not-plain-object") {
      return invalid("class-instance", path)
    }
    if (violation) {
      return invalid(
        violation.reason,
        "key" in violation ? [...path, violation.key] : path
      )
    }

    const entries = Object.entries(value)
    const separatorError = accountCharacters(
      budget,
      entries.length + Math.max(0, entries.length - 1),
      path
    )
    if (separatorError) return separatorError

    for (const [key, propertyValue] of entries) {
      const keySizeError = accountString(budget, key, [...path, key])
      if (keySizeError) return keySizeError
      if (!hasValidUnicode(key)) {
        return invalid("invalid-unicode", [...path, key])
      }

      const propertyError = validateJsonValue(
        propertyValue,
        [...path, key],
        ancestors,
        budget
      )
      if (propertyError) return propertyError
    }
    return undefined
  } finally {
    ancestors.delete(value)
  }
}

function dataPropertyValue(object: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key)
  if (!descriptor || !("value" in descriptor)) {
    throw new Error("Validated canonical invocation changed before isolation")
  }
  return descriptor.value
}

/**
 * Copies validated JSON away from prototypes that `canonicalize` may consult.
 * The dependency intentionally honors `toJSON`; receipt identity must not.
 */
function isolateFromInheritedToJson(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value

  if (Array.isArray(value)) {
    const isolated = new Array<unknown>(value.length)
    Object.defineProperty(isolated, "toJSON", { value: undefined })

    for (let index = 0; index < value.length; index += 1) {
      isolated[index] = isolateFromInheritedToJson(
        dataPropertyValue(value, String(index))
      )
    }

    return isolated
  }

  const isolated: Record<string, unknown> = Object.create(null)
  for (const key of Object.keys(value)) {
    isolated[key] = isolateFromInheritedToJson(dataPropertyValue(value, key))
  }
  return isolated
}

function serializeCanonically(
  value: unknown
): Result<
  { readonly json: string; readonly isolated: unknown },
  CanonicalInvocationError
> {
  const validationError = validateJsonValue(value, [], new WeakSet(), {
    remainingValues: MAX_CANONICAL_VALUES,
    remainingCharacters: MAX_CANONICAL_CHARACTERS,
  })
  if (validationError) return err(validationError)

  const isolated = isolateFromInheritedToJson(value)
  const json = canonicalize(isolated)
  if (json === undefined) {
    throw new Error("Validated canonical invocation did not serialize")
  }
  return ok({ json, isolated })
}

/**
 * Serializes one value as RFC 8785 canonical JSON after the same validation
 * receipt identity uses, so two values compare equal exactly when their JSON
 * data is equal.
 * Values may share references. Their expanded JSON is limited to 10,000 values,
 * 100 nested property/index steps, and 1,048,576 UTF-16 code units.
 * @param value Candidate JSON value.
 * @returns Canonical JSON, or the first unsupported value.
 */
export function canonicalJson(
  value: unknown
): Result<string, CanonicalInvocationError> {
  const serialized = serializeCanonically(value)
  return serialized.ok ? ok(serialized.value.json) : serialized
}

/**
 * Computes the receipt identity of a parsed invocation under a protocol ID,
 * with the isolated copy of the invocation that identity describes.
 *
 * Compare `canonical.bytes`, not `canonical.sha256`, to prove two deliveries
 * are one request (see {@link CanonicalInvocation}). It has no side effects, so
 * it is safe to call before claiming a receipt.
 *
 * The complete identity envelope uses the same expanded-tree limits as
 * {@link canonicalJson}; exceeding a limit returns `resource-limit`.
 *
 * @param protocolId Stable protocol identifier included in the identity material.
 * @param invocation Parsed invocation whose name and arguments form the request intent.
 * @returns A promise for the canonical identity and isolated invocation, or a typed failure for unsupported JSON input.
 */
export async function prepareCanonicalInvocation<Name extends string, Args>(
  protocolId: string,
  invocation: MutationInvocation<Name, Args>
): Promise<
  Result<PreparedCanonicalInvocation<Name, Args>, CanonicalInvocationError>
> {
  const serialized = serializeCanonically({ protocol: protocolId, invocation })
  if (!serialized.ok) return serialized

  const { json } = serialized.value
  const isolatedEnvelope = serialized.value.isolated as {
    readonly invocation: MutationInvocation<Name, Args>
  }
  const bytes = new TextEncoder().encode(json)
  return ok({
    canonical: { json, bytes, sha256: await sha256Hex(bytes) },
    invocation: isolatedEnvelope.invocation,
  })
}
