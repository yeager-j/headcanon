# Realtime updates

Realtime invalidations tell mounted views that newer server data exists. They complement optimistic mutations: the editing client predicts its own change immediately, while other clients learn which revisions they need to load.

Headcanon includes an Ably publisher, a client subscription adapter, and an optional polling fallback. Your application owns token issuance and decides which axes each viewer may observe.

This guide extends the note editor in [Getting started](getting-started.md), using its notes table, `requireActor()`, and `noteAxis()` helper. It assumes you already have an Ably app and a server API key permitted to publish and issue subscribe-capable tokens for your chosen channels.

## How updates reach a view

1. A server command commits data and records its accepted revisions.
2. The generated Server Action expires affected cache tags, requests a refresh for the editing client, and publishes invalidations.
3. Other subscribed roots receive an axis and revision, then refresh through their normal data-loading path when that revision is newer than their canon.
4. The loader checks access and returns confirmed data. Each root reapplies its own pending predictions over that data.

An invalidation contains only `{ eventId, axis, revision }`. It carries no note title, row data, or mutation arguments. Receiving one does not update `value` directly or count as canonization; the loader must return canon that covers the required revisions.

Without a realtime adapter, the editing client still receives the generated action's route refresh. Other clients need another reason to refresh.

## 1. Install Ably and choose a namespace

```sh
npm install ably
```

The package supports Ably `^2.22.1`. The token endpoint below also uses the Zod dependency from Getting started.

Configure these environment variables:

```dotenv
# .env.local — use your own server API key
ABLY_API_KEY=your-server-api-key
NEXT_PUBLIC_HEADCANON_NAMESPACE=headcanon:development
```

Keep `ABLY_API_KEY` on the server. The namespace is public and must match in the publisher, token endpoint, and browser. Give production and separate preview deployments different namespaces so their revision notifications do not mix.

Create a shared configuration module:

```ts
// lib/realtime/namespace.ts
import { ablyChannelNamespace } from "headcanon/ably/channels"

const namespace = process.env.NEXT_PUBLIC_HEADCANON_NAMESPACE
if (!namespace) throw new Error("Missing realtime namespace")

export const realtimeNamespace = ablyChannelNamespace(namespace)
```

Namespaces contain ASCII letters, digits, `_`, `.`, or `-`, with optional colon-separated segments. Empty segments, whitespace, and trailing colons are invalid. The parser throws rather than trimming or rewriting the value.

Headcanon derives each axis's Ably channel name by hashing the axis under the namespace. Your code works with axes and never needs the channel names. Hashing bounds the name's length; it does not conceal the axis. The payload still includes the axis in plain text, so do not put secrets in axis names.

## 2. Publish accepted revisions

Create a server-only REST client and publisher:

```ts
// lib/realtime/server.ts
import "server-only"

import { Rest } from "ably"
import type { InvalidationPublicationFailure } from "headcanon"
import {
  AblyInvalidationPublicationError,
  createAblyInvalidationPublisher,
} from "headcanon/ably/server"

import { realtimeNamespace } from "./namespace"

const key = process.env.ABLY_API_KEY
if (!key) throw new Error("Missing Ably API key")

export const ablyRest = new Rest({ key })

function reportInvalidationFailure(failure: InvalidationPublicationFailure) {
  if (failure.error instanceof AblyInvalidationPublicationError) {
    console.error("Realtime publication failed for some axes:", {
      eventId: failure.eventId,
      failures: failure.error.failures,
    })
    return
  }

  console.error("Realtime publication did not complete:", failure)
}

export const noteInvalidations = createAblyInvalidationPublisher({
  rest: ablyRest,
  namespace: realtimeNamespace,
  onFailure: reportInvalidationFailure,
})
```

The publisher owns its failure reporter. `onFailure` receives each publication that Ably rejects or that times out. It is required, so decide where these diagnostics go.

Pass the publisher to the generated action from [Server setup](server-setup.md):

```ts
// lib/notes/actions.ts
"use server"

import { noteInvalidations } from "@/lib/realtime/server"
import { createNextMutationAction } from "headcanon/next/server"

import { notesBinder } from "./binder"
import { renameNoteBinding } from "./commands/rename-note"
import { notesProtocol } from "./protocol"

export const applyNotesMutation = createNextMutationAction({
  protocol: notesProtocol,
  binder: notesBinder,
  commands: [renameNoteBinding],
  invalidations: noteInvalidations,
})
```

The action publishes after optional `finalizeAccepted`, cache invalidation, and route refresh. Accepted receipt recovery runs these steps again. If `finalizeAccepted` throws, the action still attempts invalidation, refresh, and publication before propagating the error.

The publisher sends one message per stamped axis, sharing one event ID for that publication. It batches up to 100 channels per request. Any failure rejects with `AblyInvalidationPublicationError`; its `failures` lists the axes Ably did not accept, and all other axes were published.

## 3. Authorize subscriptions on the server

The browser adapter asks for the exact axes observed by all its mounted roots. Treat that list as a request, never as proof of permission.

This endpoint checks each requested axis against the signed-in user's notes. It rejects the entire request if any axis is not a note the user owns, then signs subscribe-only access for exactly those axes:

```ts
// app/api/realtime/token/route.ts
import { requireActor } from "@/lib/auth"
import { db } from "@/lib/db"
import { notes } from "@/lib/db/schema"
import { noteAxis } from "@/lib/notes/protocol"
import { realtimeNamespace } from "@/lib/realtime/namespace"
import { ablyRest } from "@/lib/realtime/server"
import { and, eq, inArray } from "drizzle-orm"
import { createAblyAxisTokenRequest } from "headcanon/ably/server"
import { z } from "zod"

const requestSchema = z.object({
  axes: z.array(z.string().min(1)).min(1).max(128),
})

/** The note ID in a `noteAxis()` value, or null for any other axis. */
function noteIdOf(axis: string): string | null {
  const id = /^notes\/(.+)$/.exec(axis)?.[1]
  return id !== undefined && z.uuid().safeParse(id).success ? id : null
}

export async function POST(request: Request) {
  const actor = await requireActor()
  const body = await request.json().catch(() => null)
  const parsed = requestSchema.safeParse(body)
  if (!parsed.success) {
    return new Response("Invalid axis request", { status: 400 })
  }

  const noteIds = parsed.data.axes.map(noteIdOf)
  if (noteIds.some((id) => id === null)) {
    return new Response("Forbidden", { status: 403 })
  }

  const requestedIds = [...new Set(noteIds as string[])]
  const ownedNotes = await db
    .select({ id: notes.id })
    .from(notes)
    .where(
      and(inArray(notes.id, requestedIds), eq(notes.ownerId, actor.userId))
    )
  if (ownedNotes.length !== requestedIds.length) {
    return new Response("Forbidden", { status: 403 })
  }

  const tokenRequest = await createAblyAxisTokenRequest({
    rest: ablyRest,
    namespace: realtimeNamespace,
    axes: ownedNotes.map(({ id }) => noteAxis(id)),
    clientId: actor.userId,
    ttlMs: 10 * 60 * 1000,
  })

  return Response.json(tokenRequest, {
    headers: { "Cache-Control": "no-store" },
  })
}
```

The axes passed to `createAblyAxisTokenRequest` come from `noteAxis()` and rows the server read, never from the browser's strings. The helper derives each axis's channel and grants `subscribe` on exactly those channels. The axis count limit is an application choice in this example, not a Headcanon adapter limit.

Extend the policy when roots observe collection or workspace axes. Apply your tenant and viewer rules to every axis. When you set `clientId`, take it from trusted server identity; a viewer without an account gets none (see [Serve viewers without an account](#serve-viewers-without-an-account)). Never pass the browser's axes through unchecked or grant a wildcard merely to make attachment succeed. Issued capabilities must also be permitted by your Ably API key. See [Ably capabilities](https://ably.com/docs/auth/capabilities).

The helper returns a signed native Ably `TokenRequest`, which the browser's SDK exchanges for a token. Ably recommends its own tokens over JWTs when capability lists are large, because a JWT must fit in an HTTP header (about 8 KB); see [Ably token authentication](https://ably.com/docs/auth/token).

## 4. Create a shared browser adapter

`createAblyAxisInvalidations` creates the browser side. Nothing loads until a mounted root first subscribes, so server rendering never creates an Ably client:

```ts
// lib/realtime/client.ts
"use client"

import { createAblyAxisInvalidations } from "headcanon/ably/client"

import { realtimeNamespace } from "./namespace"

export const axisInvalidations = createAblyAxisInvalidations({
  namespace: realtimeNamespace,
  async createRealtime(options) {
    const { Realtime } = await import("ably")
    return new Realtime(options)
  },
  async requestToken(axes) {
    const response = await fetch("/api/realtime/token", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ axes }),
      signal: AbortSignal.timeout(10_000),
    })

    if (!response.ok || response.redirected) {
      throw new Error("Realtime authorization failed")
    }

    return response.json()
  },
  onLifecycleError: (error) => console.error("Realtime lifecycle:", error),
  onMalformedMessage: (error) => console.warn("Invalid message:", error),
  onInitializationError: (error) =>
    console.error("Realtime initialization failed:", error),
})
```

Pass `options` to the SDK constructor unchanged. It holds `autoConnect: false`, so the first connection waits for the adapter's first authorization, and Headcanon's `authCallback`. Import the SDK inside `createRealtime`, as shown, to keep it out of the first page bundle; a static import also works but loads Ably on every page. To use Ably's modular SDK instead, construct `BaseRealtime` from `ably/modular` with `{ ...options, plugins: { WebSocketTransport, FetchRequest } }`.

When Ably asks for a token, Headcanon translates the requested channels back into axes and calls `requestToken` with them. A channel the adapter does not observe at that moment is dropped, so a token is never wider than what the roots observe when it is requested. Ably also calls back through `requestToken` to renew a token before it expires. See [Ably's Auth API](https://ably.com/docs/sdk/js/v2.0/interfaces/ably.Auth.html).

If realtime is off in some environments, for example when `ABLY_API_KEY` is not set, pass a loader as `namespace` that resolves `null` there, such as one that asks the server. Subscriptions then report `"unavailable"`, and the SDK never loads.

Share this module across roots. The adapter combines their axes, requests one deduplicated subscribe-only capability, and attaches channels after authorization succeeds. The connection should be dedicated to this adapter: its exact-set authorization replaces the current token capability, so unrelated channel consumers should not share it.

While the adapter is starting, status is `"reauthorizing"`; a failed start becomes `"unavailable"`. `axisInvalidations.retry()` runs a failed start again, for example after the namespace loader resolved `null` or the client could not be created. Otherwise it retries authorization and attachment.

This module assumes one viewer identity for the page's lifetime: one signed-in user, or one viewer without an account. Use a full page navigation when the viewer signs in, signs out, or changes accounts, or implement a session-scoped adapter that closes the old Ably client and creates a new one. Unsubscribing the last root releases its channels and listeners; it does not close the SDK connection for you.

## 5. Connect predicted and observed roots

Add the same adapter to the root from [React usage](react.md):

```ts
// lib/notes/root.ts
"use client"

import { axisInvalidations } from "@/lib/realtime/client"
import {
  createNextObservedRoot,
  createNextPredictedRoot,
} from "headcanon/next/client"
import { createPredictedRootContext } from "headcanon/react"

import { applyNotesMutation } from "./actions"
import { notesProtocol } from "./protocol"

export const useNote = createNextPredictedRoot({
  protocol: notesProtocol,
  action: applyNotesMutation,
  invalidations: axisInvalidations,
})

export const NoteRoot = createPredictedRootContext(useNote, {
  name: "NoteRoot",
})

export const useObservedNote = createNextObservedRoot({
  invalidations: axisInvalidations,
})
```

Each root subscribes to the axes in its current `canon.revisions`. Changes to that set update the subscriptions. A view that never observes an axis will not hear its notifications. In particular, a list needs a collection axis to discover new members; see [Loading data](loading-data.md#lists-empty-results-and-deletion).

Keep axis names, revisions, and namespace consistent across writers, token policy, and loaders. Realtime cannot correct a loader that returns an old value with a newer revision.

## Serve viewers without an account

Some resources can be read by anyone with the link, such as a shared note. A reader with no account can still get live invalidations. The browser adapter and the roots stay the same. Only the token endpoint changes.

This example extends the endpoint above. It assumes the notes table has a boolean `readableByLink` column, and a `getActor()` helper that returns `{ userId }` for a signed-in user and `null` for anyone else, without a redirect:

```ts
// app/api/realtime/token/route.ts — with notes readable by link
import { getActor } from "@/lib/auth"
import { and, eq, inArray, or } from "drizzle-orm"

// requestSchema and noteIdOf as above.

export async function POST(request: Request) {
  const actor = await getActor()
  const body = await request.json().catch(() => null)
  const parsed = requestSchema.safeParse(body)
  if (!parsed.success) {
    return new Response("Invalid axis request", { status: 400 })
  }

  const noteIds = parsed.data.axes.map(noteIdOf)
  if (noteIds.some((id) => id === null)) {
    return new Response("Forbidden", { status: 403 })
  }

  const readableByViewer = actor
    ? or(eq(notes.readableByLink, true), eq(notes.ownerId, actor.userId))
    : eq(notes.readableByLink, true)
  const requestedIds = [...new Set(noteIds as string[])]
  const readableNotes = await db
    .select({ id: notes.id })
    .from(notes)
    .where(and(inArray(notes.id, requestedIds), readableByViewer))
  if (readableNotes.length !== requestedIds.length) {
    return new Response("Forbidden", { status: 403 })
  }

  const tokenRequest = await createAblyAxisTokenRequest({
    rest: ablyRest,
    namespace: realtimeNamespace,
    axes: readableNotes.map(({ id }) => noteAxis(id)),
    clientId: actor?.userId,
    ttlMs: 5 * 60 * 1000,
  })

  return Response.json(tokenRequest, {
    headers: { "Cache-Control": "no-store" },
  })
}
```

Follow these rules for a viewer without an account:

- **Check the read policy, not membership.** There is no user to check, so the endpoint checks each axis against the resource's own rule, here `readableByLink`. It still refuses the whole request if one axis fails.
- **Omit `clientId`, or keep one ID for the whole connection.** Ably fixes a connection's client ID when it connects; see [Ably identified clients](https://ably.com/docs/auth/identified-clients). The adapter requests a new token on its first authorization, each time the observed axes change, and each time Ably renews a token. A token with a different client ID fails. So do not make a random ID for each request. If you need an ID for an anonymous viewer, make it once, store it (for example, in a cookie), and send the same one every time.
- **Replace the connection on sign-in and sign-out.** The viewer's client ID changes, so the old connection cannot renew. Use a full page navigation, or a session-scoped adapter that closes the old Ably client, as in [Create a shared browser adapter](#4-create-a-shared-browser-adapter).
- **Revoke by refusing the next token.** When a note stops being readable by link, the endpoint refuses its next token request. A token already issued stays valid until it expires, so keep `ttlMs` short. The loader must also check access on every read: an invalidation carries no data, and the refresh it causes returns only what the loader allows.

A viewer without an account cannot mutate, so pair the endpoint with an observed root:

```tsx
// app/shared/[id]/shared-note.tsx
"use client"

import type { NoteState } from "@/lib/notes/protocol"
import { axisInvalidations } from "@/lib/realtime/client"
import type { Canon } from "headcanon"
import { createNextObservedRoot } from "headcanon/next/client"

const useSharedNote = createNextObservedRoot({
  invalidations: axisInvalidations,
})

export function SharedNote({ canon }: { canon: Canon<NoteState> }) {
  const { value, status, retryRefresh } = useSharedNote({ canon })

  return (
    <article>
      <h1>{value.title}</h1>
      {status.freshness === "stalled" && (
        <button type="button" onClick={retryRefresh}>
          Refresh note
        </button>
      )}
    </article>
  )
}
```

The page's server component loads the note only while it is readable by link or owned by the viewer, and passes its canon to `SharedNote`. When the note stops being readable, the next refresh reaches the loader, which can return `notFound()`.

## Recover after missed messages

The adapter requests a gap refresh when a subscription first becomes active, even if another root already uses its channels. It also reports gaps after connection recovery or channel events that indicate lost message continuity. Connection and channel recovery can each request a refresh during the same outage.

A gap means messages may have been missed without a known revision target. The root needs a successful refresh that started after the gap was reported; a failed refresh does not close it. Receiving an invalidation alone does not close the gap either. With the router carrier, a failed refresh does not stay open in the browser: Next.js reloads the page. See [Loading data](loading-data.md#a-failed-router-refresh-reloads-the-page).

### Refresh when the viewer returns

While the transport is `"active"`, nothing refreshes a root when the user comes back to the tab. The root can still be behind: a server publication can fail while the client stays connected, and a root with no push transport hears nothing at all. To refresh on each return, wrap the adapter. In `lib/realtime/client.ts`, import `withVisibilityRefresh` from `headcanon`, rename the `createAblyAxisInvalidations` result to `pushInvalidations`, then export:

```ts
export const axisInvalidations = withVisibilityRefresh(pushInvalidations)
```

Each time the document becomes visible, the wrapper reports a gap to every subscription, whatever the transport's status. Each root then runs one refresh through its carrier. Statuses pass through unchanged, and `retry()` still reaches the Ably adapter.

While the browser reports it is offline (`navigator.onLine === false`), the wrapper does not report the return. It reports it when the browser's `online` event fires, if the page is still visible. This avoids a refresh that is likely to fail; see [Loading data](loading-data.md#a-failed-router-refresh-reloads-the-page).

For a root with no push transport, wrap the no-realtime adapter and pass it as the root's `invalidations`:

```ts
import {
  createNoRealtimeInvalidationAdapter,
  withVisibilityRefresh,
} from "headcanon"

export const soloInvalidations = withVisibilityRefresh(
  createNoRealtimeInvalidationAdapter()
)
```

The wrapper composes with `withPollingFallback` in either order. When both report the same return, the gaps arrive together and the root runs one refresh.

The adapter reauthorizes when the observed channel set changes or authorization needs recovery. A recovered connection can reuse its existing token. The SDK separately handles token expiry through the authentication callback. Removing subscriptions releases unused channels without waiting for authorization to finish; removing all subscriptions does not request an empty capability token.

Permission changes in your database do not automatically revoke already issued tokens. Choose a token lifetime and revocation policy that fit your access rules, and continue checking access in loaders. See [Ably token revocation](https://ably.com/docs/auth/revocation).

## Add polling fallback

Wrap the shared adapter to refresh while push delivery is degraded. In `lib/realtime/client.ts`, import `withPollingFallback` from `headcanon`, rename the `createAblyAxisInvalidations` result to `pushInvalidations`, then export:

```ts
export const axisInvalidations = withPollingFallback(pushInvalidations, {
  intervalMs: 15_000,
})
```

The wrapper keeps `retry()`, so `axisInvalidations.retry()` still reaches the Ably adapter. To let some roots poll and others stay push-only, export both adapters and choose one per root. To also refresh when the viewer returns while push is active, wrap the result with `withVisibilityRefresh` (see [Refresh when the viewer returns](#refresh-when-the-viewer-returns)).

While the underlying adapter reports `"disabled"`, `"reauthorizing"`, or `"unavailable"`, the wrapper reports `"polling"` and signals a subscription gap on each interval. The root refreshes through its existing router or snapshot adapter. Polling stops when the transport reports `"active"`. Because Ably reports `"reauthorizing"` while it starts, status also shows `"polling"` on every page load until the channels attach; this is expected.

Polling pauses while the document is hidden by default. When it becomes visible again during fallback, the wrapper reports a gap and restarts the interval. Set `pauseWhenHidden: false` to keep polling in hidden documents. The interval must be a finite positive number, and each subscription owns its polling timer.

Polling also stops requesting refreshes while the browser reports it is offline (`navigator.onLine === false`). With the router carrier, a refresh that fails reloads the page and loses the root's queue and any unsaved drafts; see [Loading data](loading-data.md#a-failed-router-refresh-reloads-the-page). The interval keeps running, but it skips each tick while offline. When the browser's `online` event fires during fallback, the wrapper reports a gap at once. `navigator.onLine` is only a hint: a browser can report online without a working connection.

Fallback does not retry Ably authorization, attachment, or a failed start by itself. It supplies another route to fresh data while transport recovery happens separately, through `retry()`.

For polling without a push service, use this alternative client module:

```ts
// lib/realtime/client.ts — polling-only alternative
"use client"

import {
  createNoRealtimeInvalidationAdapter,
  withPollingFallback,
} from "headcanon"

export const axisInvalidations = withPollingFallback(
  createNoRealtimeInvalidationAdapter(),
  { intervalMs: 15_000 }
)
```

This alternative needs no Ably client, publisher, or token endpoint. Omit both publication options from the Server Action. Merely omitting `invalidations` on a root does not enable polling.

## Read status and choose a retry

| `status.invalidations` | Meaning                                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `"disabled"`           | No push transport is configured for this root.                                                                        |
| `"reauthorizing"`      | Initialization, authorization, or attachment is not complete.                                                         |
| `"active"`             | The adapter is connected and all its desired channels are attached.                                                   |
| `"unavailable"`        | The connection or a desired channel is unavailable, or reconciliation failed with required channels still unattached. |
| `"polling"`            | A fallback wrapper is requesting refreshes while the underlying transport is degraded.                                |

Transport status and data freshness are separate. An active connection does not prove that canon covers every known revision. A root can also be current without a working push transport, while remaining unaware of later remote writes.

| Problem                                                                   | Control                                      |
| ------------------------------------------------------------------------- | -------------------------------------------- |
| Ably startup, authorization, or channel attachment needs another attempt. | Call `axisInvalidations.retry()`.            |
| The root's data refresh stalled.                                          | Call the root's `retryRefresh()`.            |
| A submitted mutation's delivery is uncertain.                             | Call the predicted root's `retryDelivery()`. |

The Ably adapter's `retry()` runs a failed start again. Otherwise it requests reconciliation: authorization when needed, followed by attachment of desired channels that are not attached. It does not repair bad credentials, recreate a closed SDK client, or retry mutation delivery. See [React usage](react.md#offer-the-right-retry-control) for inline data and delivery controls.

## Handle publication failures

An accepted database write stays accepted if publication fails. Generated actions wait up to one second for publication, report rejection or timeout through the publisher's `onFailure`, and preserve the accepted outcome. Timing out does not cancel the underlying publish operation; it may finish later.

The publisher has no durable retry queue. Connect the failure reporter to your application's diagnostics, and use a durable publication mechanism if missing a notification is unacceptable.

Polling fallback only runs while the client transport is degraded. It does not repair a server publication failure while the client remains `"active"`. That client may stay unaware until another invalidation, a later gap refresh, or an independent refresh occurs. `withVisibilityRefresh` limits the delay: the client refreshes the next time the viewer returns to the tab. See [Refresh when the viewer returns](#refresh-when-the-viewer-returns).

Background writes must also advance revisions and expire the relevant caches before notifying readers. See [Loading data](loading-data.md#refresh-after-writes) for the external-commit helpers and their Next.js server context requirements.

## Check the integration

1. Open the same note in two browser sessions signed in as the note's owner; this guide's token endpoint admits only the owner. Both roots should reach `"active"` after initial attachment and refresh.
2. Rename the note in one session. Its prediction appears immediately; the other session refreshes and displays the saved title.
3. Disconnect a client, make another change elsewhere, then reconnect. The gap refresh should bring the client up to date.
4. If fallback is enabled, make the transport unavailable while keeping application requests reachable. Status should become `"polling"`, and visible clients should refresh on the configured interval.
5. Request another user's note axis from the token endpoint. It should refuse authorization even if the browser knows the note ID.

For missing updates, check the namespace, granted channel set, stamped revisions, and loader cache tags first. A channel can be connected correctly while the loader still returns stale data. Malformed messages or messages naming an axis different from their channel are dropped and reported through `onMalformedMessage`.

## Further reading

- [Loading data](loading-data.md) — revisions, collection axes, and cache invalidation.
- [React usage](react.md) — freshness, recovery controls, and observed roots.
- [Server setup](server-setup.md) — accepted finalization and receipt recovery.
- [Testing](testing.md) — planned guide to invalidation contract tests.
