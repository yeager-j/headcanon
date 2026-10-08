/**
 * Whether a string is well-formed UTF-16: every surrogate is part of a pair.
 *
 * A lone surrogate has no UTF-8 encoding, so `TextEncoder` replaces it with
 * U+FFFD. Two such strings can then encode to the same bytes. Every boundary
 * that hashes or serializes a string as UTF-8 rejects these strings first.
 * @param value String to check.
 * @returns Whether UTF-8 encoding preserves the string exactly.
 */
export function isWellFormedUnicode(value: string): boolean {
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
