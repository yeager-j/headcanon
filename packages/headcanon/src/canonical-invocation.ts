import canonicalize from "canonicalize"

import { err, ok, type Result } from "@workspace/result"

import type { MutationInvocation } from "./protocol"

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

/** A parsed invocation together with the exact bytes used for receipt identity. */
export interface PreparedCanonicalInvocation<Name extends string, Args> {
  readonly canonical: CanonicalInvocation
  readonly invocation: MutationInvocation<Name, Args>
}

/** A fail-closed input or hashing failure while preparing receipt identity. */
export type CanonicalInvocationError =
  | {
      readonly code: "invalid-json-value"
      readonly reason:
        | "undefined"
        | "function"
        | "symbol"
        | "bigint"
        | "non-finite-number"
        | "cyclic"
        | "class-instance"
        | "invalid-unicode"
        | "symbol-key"
        | "accessor-property"
        | "non-enumerable-property"
        | "unsupported-array-property"
      readonly path: readonly (string | number)[]
    }
  | {
      readonly code: "hash-unavailable" | "hash-failed"
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
  reason: Extract<
    CanonicalInvocationError,
    { code: "invalid-json-value" }
  >["reason"],
  path: readonly (string | number)[]
): Extract<CanonicalInvocationError, { code: "invalid-json-value" }> {
  return { code: "invalid-json-value", reason, path }
}

function validateJsonValue(
  value: unknown,
  path: readonly (string | number)[],
  ancestors: WeakSet<object>
): CanonicalInvocationError | undefined {
  if (value === null || typeof value === "boolean") return undefined

  if (typeof value === "string") {
    return hasValidUnicode(value) ? undefined : invalid("invalid-unicode", path)
  }
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? undefined
      : invalid("non-finite-number", path)
  }
  if (typeof value === "undefined") return invalid("undefined", path)
  if (typeof value === "function") return invalid("function", path)
  if (typeof value === "symbol") return invalid("symbol", path)
  if (typeof value === "bigint") return invalid("bigint", path)

  if (ancestors.has(value)) return invalid("cyclic", path)

  const isArray = Array.isArray(value)
  const prototype = Object.getPrototypeOf(value)
  if (
    (isArray && prototype !== Array.prototype) ||
    (!isArray && prototype !== Object.prototype && prototype !== null)
  ) {
    return invalid("class-instance", path)
  }

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

      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor) return invalid("undefined", [...path, index])
        if (!("value" in descriptor)) {
          return invalid("accessor-property", [...path, index])
        }

        const elementError = validateJsonValue(
          descriptor.value,
          [...path, index],
          ancestors
        )
        if (elementError) return elementError
      }
      return undefined
    }

    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === "symbol") return invalid("symbol-key", path)
      if (!hasValidUnicode(key))
        return invalid("invalid-unicode", [...path, key])

      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable) {
        return invalid("non-enumerable-property", [...path, key])
      }
      if (!("value" in descriptor)) {
        return invalid("accessor-property", [...path, key])
      }

      const propertyError = validateJsonValue(
        descriptor.value,
        [...path, key],
        ancestors
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

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  )
}

/**
 * Produces environment-independent receipt identity for a parsed invocation.
 *
 * The full `{ protocol, invocation }` envelope is validated as plain JSON,
 * isolated from inherited `toJSON` behavior, serialized with RFC 8785 ordering,
 * and hashed from the exact UTF-8 bytes. Consumers should compare `bytes` when
 * proving duplicate-delivery identity; `sha256` is a useful indexed lookup and
 * diagnostic fingerprint, but is not the equality proof. The operation has no
 * persistence or authority side effect and is safe to run before claiming a
 * receipt.
 *
 * @param protocolId Stable protocol identifier included in the identity material.
 * @param invocation Parsed invocation whose name and arguments form the request intent.
 * @returns A promise for canonical identity, or a typed failure for unsupported JSON or unavailable hashing.
 */
export async function prepareCanonicalInvocation<Name extends string, Args>(
  protocolId: string,
  invocation: MutationInvocation<Name, Args>
): Promise<
  Result<PreparedCanonicalInvocation<Name, Args>, CanonicalInvocationError>
> {
  const envelope = { protocol: protocolId, invocation }
  const validationError = validateJsonValue(envelope, [], new WeakSet())
  if (validationError) return err(validationError)

  const isolatedEnvelope = isolateFromInheritedToJson(envelope) as {
    readonly protocol: string
    readonly invocation: MutationInvocation<Name, Args>
  }
  const json = canonicalize(isolatedEnvelope)
  if (json === undefined) {
    throw new Error("Validated canonical invocation did not serialize")
  }

  const bytes = new TextEncoder().encode(json)
  if (!globalThis.crypto?.subtle) return err({ code: "hash-unavailable" })

  try {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes)
    return ok({
      canonical: {
        json,
        bytes,
        sha256: toHex(new Uint8Array(digest)),
      },
      invocation: isolatedEnvelope.invocation,
    })
  } catch {
    return err({ code: "hash-failed" })
  }
}

/**
 * Canonicalizes a protocol invocation and computes its exact SHA-256 receipt identity.
 *
 * @param protocolId Stable protocol identifier included in the identity material.
 * @param invocation Serializable invocation to validate and canonicalize.
 * @returns A promise for the canonical invocation, or a typed failure for unsupported input or hashing failure.
 */
export async function canonicalInvocation<Name extends string, Args>(
  protocolId: string,
  invocation: MutationInvocation<Name, Args>
): Promise<Result<CanonicalInvocation, CanonicalInvocationError>> {
  const prepared = await prepareCanonicalInvocation(protocolId, invocation)
  return prepared.ok ? ok(prepared.value.canonical) : prepared
}
