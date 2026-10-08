declare const namespaceBrand: unique symbol

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
