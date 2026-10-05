import { fileURLToPath } from "node:url"
import type { NextConfig } from "next"

/**
 * Mirrors the physics of a production consumer: plain App Router,
 * no cacheComponents flag, Server Actions finalizing with server-side
 * `refresh()`. The fixture must reproduce what the app experiences, not an
 * idealized harness.
 */
const nextConfig: NextConfig = {
  // The workspace root, where npm hoists `next`. Next infers it from a
  // lockfile, and the repo commits none.
  turbopack: { root: fileURLToPath(new URL("..", import.meta.url)) },
}

export default nextConfig
