import type { AxisId } from "../revisions"

/** Ably event name used for singleton accepted-axis invalidations. */
export const ABLY_AXIS_INVALIDATION_EVENT = "headcanon.axis-invalidation.v1"

const AXIS_CHANNEL_VERSION = "headcanon:axis:v1"

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
}

function normalizedNamespace(namespace: string): string {
  const normalized = namespace.trim().replace(/:+$/u, "")
  if (normalized.length === 0) {
    throw new Error("An Ably axis-channel namespace is required")
  }
  return normalized
}

/** Derives a deployment-scoped channel without exposing the storage axis.
 * @param namespace Deployment-scoped application namespace.
 * @param axis Storage axis to hash.
 * @returns Derived Ably channel name.
 */
export async function ablyAxisChannelName(
  namespace: string,
  axis: AxisId
): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(axis)
  )
  return `${normalizedNamespace(namespace)}:${AXIS_CHANNEL_VERSION}:${bytesToHex(digest)}`
}

/** Builds a sorted, duplicate-free subscribe-only Ably capability claim.
 * @param channelNames Channel names to authorize.
 * @returns A canonical subscribe-only capability object.
 */
export function ablySubscribeCapability(
  channelNames: readonly string[]
): Record<string, ["subscribe"]> {
  const capability: Record<string, ["subscribe"]> = {}
  for (const channelName of [...new Set(channelNames)].sort()) {
    capability[channelName] = ["subscribe"]
  }
  return capability
}

/** Measures the canonical capability claim before application-owned issuance.
 * @param capability Capability object to encode.
 * @returns UTF-8 byte length of its JSON representation.
 */
export function ablyCapabilityByteLength(
  capability: Readonly<Record<string, readonly ["subscribe"]>>
): number {
  return new TextEncoder().encode(JSON.stringify(capability)).byteLength
}
