import type { AxisId } from "../revisions"
import { sha256Hex } from "../sha256"

declare const namespaceBrand: unique symbol

/** The one wire version shared by axis channel names and the event name. */
const WIRE_VERSION = "v1"

/** Ably event name used for singleton accepted-axis invalidations. */
export const ABLY_AXIS_INVALIDATION_EVENT =
  `headcanon.axis-invalidation.${WIRE_VERSION}` as const

/** A deployment namespace accepted by {@link ablyChannelNamespace}. */
export type AblyChannelNamespace = string & {
  readonly [namespaceBrand]: "AblyChannelNamespace"
}

const NAMESPACE_PATTERN = /^[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)*$/u

/**
 * Parses a deployment namespace once, at configuration time.
 *
 * A namespace is one or more segments of ASCII letters, digits, `_`, `.`, or
 * `-`, joined by single colons (for example `production` or `app:preview-42`).
 * The value is never trimmed or otherwise rewritten.
 * @param value Configured namespace.
 * @returns The same string carrying the namespace brand.
 * @throws Error when the value is not a valid namespace, a configuration error.
 */
export function ablyChannelNamespace(value: string): AblyChannelNamespace {
  if (!NAMESPACE_PATTERN.test(value)) {
    throw new Error(
      `Invalid Ably axis-channel namespace ${JSON.stringify(value)}: use letters, digits, "_", ".", or "-" segments joined by single colons`
    )
  }
  return value as AblyChannelNamespace
}

/**
 * Derives the deployment-scoped channel for one axis.
 *
 * The axis is hashed so that every channel name has a bounded length and only
 * channel-safe characters, whatever the axis contains. Hashing does not make
 * the axis confidential: invalidation payloads carry it in clear, and any
 * party that can guess an axis can derive its channel.
 * @param namespace Parsed deployment namespace.
 * @param axis Storage axis to address.
 * @returns Derived Ably channel name.
 */
export async function ablyAxisChannelName(
  namespace: AblyChannelNamespace,
  axis: AxisId
): Promise<string> {
  return `${namespace}:headcanon:axis:${WIRE_VERSION}:${await sha256Hex(axis)}`
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
