/**
 * A signed Ably token request, as Ably REST's `auth.createTokenRequest`
 * returns it and a realtime client's `authCallback` accepts it. The fields
 * mirror Ably's own `TokenRequest`, so the official type is assignable both
 * ways without Headcanon importing Ably.
 */
export interface AblyTokenRequest {
  readonly keyName: string
  readonly timestamp: number
  readonly nonce: string
  readonly mac: string
  /** The JSON-serialized capability the request grants. */
  readonly capability: string
  readonly clientId?: string
  readonly ttl?: number
}
