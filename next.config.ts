import type { NextConfig } from "next"

/**
 * Mirrors the physics of the real consumer (apps/web): plain App Router,
 * no cacheComponents flag, Server Actions finalizing with server-side
 * `refresh()`. The fixture must reproduce what the app experiences, not an
 * idealized harness.
 */
const nextConfig: NextConfig = {}

export default nextConfig
