import {
  createRestartableLazyAdapter,
  type RetryableInvalidationAdapter,
} from "../core/invalidation"
import type { AxisId } from "../core/revisions"
import { ablyChannelNamespace, type AblyChannelNamespace } from "./channels"
import {
  createAblyAdapterCore,
  type AblyAdapterCore,
  type AblyInvalidationMessageError,
  type AblyRealtimeClient,
} from "./realtime-adapter"
import type { AblyTokenRequest } from "./token-request"

export type {
  AblyInvalidationMessageError,
  AblyRealtimeClient,
} from "./realtime-adapter"
export type { AblyTokenRequest } from "./token-request"

/**
 * The `authCallback` Headcanon gives the realtime client. Ably calls it for
 * each `authorize()` and for token renewal, with the token parameters of the
 * last `authorize()`.
 * @param params Ably's token parameters; `capability` arrives as an object or as JSON.
 * @param callback Ably's completion callback: an error message, or the signed token request.
 * @returns Nothing; the outcome reaches Ably through `callback`.
 */
type AblyAuthCallback = (
  params: { readonly capability?: string | Readonly<Record<string, unknown>> },
  callback: (
    error: string | null,
    tokenRequest: AblyTokenRequest | null
  ) => void
) => void

/**
 * Client options Headcanon requires. Spread them into the SDK constructor
 * unchanged: `autoConnect: false` leaves the first connection to the
 * adapter's first `authorize()`, once it knows the exact channel set.
 */
export interface AblyRealtimeOptions {
  readonly autoConnect: false
  readonly authCallback: AblyAuthCallback
}

/** Options for {@link createAblyAxisInvalidations}. */
export interface AblyAxisInvalidationsOptions {
  /**
   * The deployment namespace the publisher uses, or a loader that resolves
   * it on first subscription. A loader that resolves `null` means realtime
   * is unavailable: subscriptions report `unavailable` and no client is
   * created.
   */
  readonly namespace: string | (() => Promise<string | null>)
  /**
   * Creates the realtime client on first subscription. Spread `options` into
   * the constructor, and import the SDK here so it stays out of the first
   * bundle: `async (options) => new (await import("ably")).Realtime(options)`,
   * or `BaseRealtime` from `ably/modular` with `{ ...options, plugins }`.
   */
  readonly createRealtime: (
    options: AblyRealtimeOptions
  ) => AblyRealtimeClient | Promise<AblyRealtimeClient>
  /**
   * Fetches a signed token request for exactly these axes from the
   * application's token endpoint, which checks them and signs with
   * `createAblyAxisTokenRequest`. Called for the first authorization, each
   * change to the observed axes, and Ably's token renewal. Reject to fail
   * authorization; the adapter then reports `unavailable` until `retry()`.
   */
  readonly requestToken: (axes: readonly AxisId[]) => Promise<AblyTokenRequest>
  /** Receives each inbound message the adapter drops. */
  readonly onMalformedMessage?: (error: AblyInvalidationMessageError) => void
  /** Receives authorization, attachment, and detachment failures. */
  readonly onLifecycleError?: (error: unknown) => void
  /** Receives a failure to resolve the namespace or create the client. */
  readonly onInitializationError?: (error: unknown) => void
}

function channelNamesOf(
  capability: string | Readonly<Record<string, unknown>> | undefined
): ReadonlySet<string> {
  if (typeof capability !== "string")
    return new Set(Object.keys(capability ?? {}))
  try {
    const parsed: unknown = JSON.parse(capability)
    return new Set(
      typeof parsed === "object" && parsed !== null ? Object.keys(parsed) : []
    )
  } catch {
    return new Set()
  }
}

/**
 * Turns either namespace form into one parsed loader. A string is parsed now,
 * so an invalid one fails at construction.
 */
function namespaceResolver(
  namespace: AblyAxisInvalidationsOptions["namespace"]
): () => Promise<AblyChannelNamespace | null> {
  if (typeof namespace === "string") {
    const parsed = ablyChannelNamespace(namespace)
    return async () => parsed
  }
  return async () => {
    const loaded = await namespace()
    return loaded === null ? null : ablyChannelNamespace(loaded)
  }
}

/**
 * Creates the browser's Ably invalidation transport.
 *
 * Nothing loads until the first subscription. Then the namespace resolves,
 * `createRealtime` creates the client, and the adapter authorizes exactly the
 * observed axes' channels. Ably's `authCallback` is translated back into
 * those axes before `requestToken` sees it, so the application's endpoint
 * checks axes, never hashed channel names. A channel the adapter does not
 * observe when Ably asks is dropped, so a token is never wider than the
 * observed set at request time. Removing every subscription requests no
 * narrower token: the last one stays until it
 * expires or the next authorization replaces it.
 *
 * `retry()` reruns a failed start (namespace, client, or a `null` namespace
 * that may now resolve) and otherwise retries authorization and attachment.
 * Share one instance per tab. Wrap it with `withPollingFallback` for roots
 * that should poll while push is degraded, and with `withVisibilityRefresh`
 * for roots that should refresh when the viewer returns to the page; both
 * wrappers keep `retry()`.
 *
 * @param options Namespace, client factory, token request, and diagnostics.
 * @returns A retryable invalidation adapter that starts on first subscription.
 * @throws Error at construction when a string `namespace` is invalid (see `ablyChannelNamespace`).
 */
export function createAblyAxisInvalidations(
  options: AblyAxisInvalidationsOptions
): RetryableInvalidationAdapter {
  const resolveNamespace = namespaceResolver(options.namespace)
  let core: AblyAdapterCore | null = null

  /**
   * One client's `authCallback`, bound to that client's own adapter: a client
   * abandoned by a failed start keeps no subscriptions, so it can never
   * borrow a later client's observed axes for a token.
   */
  const authCallbackFor =
    (owner: { core: AblyAdapterCore | null }): AblyAuthCallback =>
    (params, callback) => {
      const names = channelNamesOf(params.capability)
      const axes = owner.core?.axesForChannels(names) ?? []
      if (axes.length === 0) {
        callback("No observed axes to authorize", null)
        return
      }
      options.requestToken(axes).then(
        (tokenRequest) => callback(null, tokenRequest),
        (error: unknown) =>
          callback(
            error instanceof Error
              ? error.message
              : "Realtime authorization failed",
            null
          )
      )
    }

  const lazy = createRestartableLazyAdapter({
    async initialize() {
      core = null
      // Resolved and parsed before the client exists, so a bad namespace
      // never leaves an orphaned connection behind.
      const namespace = await resolveNamespace()
      if (namespace === null) return null
      const owner: { core: AblyAdapterCore | null } = { core: null }
      const realtime = await options.createRealtime({
        autoConnect: false,
        authCallback: authCallbackFor(owner),
      })
      owner.core = createAblyAdapterCore({
        realtime,
        namespace,
        onMalformedMessage: options.onMalformedMessage,
        onLifecycleError: options.onLifecycleError,
      })
      core = owner.core
      return core.adapter
    },
    onInitializationError: options.onInitializationError,
  })

  return {
    get initialStatus() {
      return lazy.initialStatus
    },
    subscribe: lazy.subscribe,
    retry() {
      if (!lazy.restart()) core?.adapter.retry()
    },
  }
}
