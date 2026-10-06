/**
 * Lowercase hex SHA-256 of a UTF-8 string or exact bytes.
 *
 * Uses the global WebCrypto, present in browsers and in every Node version
 * `engines` admits, so browser and server entries hash identically.
 * @param input UTF-8 text or exact bytes to hash.
 * @returns The 64-character lowercase hex digest.
 */
export async function sha256Hex(
  input: string | Uint8Array<ArrayBuffer>
): Promise<string> {
  const bytes =
    typeof input === "string" ? new TextEncoder().encode(input) : input
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
}
