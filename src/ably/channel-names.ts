// The Ably wire names the publisher, the token helper, and the adapter share.
// Not a package export: applications work with axes, never channel names.
import type { AxisId } from "../core/revisions"
import { sha256Hex } from "../core/sha256"
import type { AblyChannelNamespace } from "./channels"

/** The one wire version shared by axis channel names and the event name. */
const WIRE_VERSION = "v1"

/** Ably event name used for singleton accepted-axis invalidations. */
export const ABLY_AXIS_INVALIDATION_EVENT =
  `headcanon.axis-invalidation.${WIRE_VERSION}` as const

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
