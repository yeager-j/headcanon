# Loading data

Headcanon needs confirmed server data and the revisions that describe it. Together, these form a **canon**. The client displays pending predictions over that canon until refreshed data confirms the accepted changes.

This guide uses the notes table, `requireActor()`, and shared `noteAxis()` helper from [Getting started](getting-started.md).

## Choose a loader

| Your read path                                | Use                                              | What Headcanon adds                                                                          |
| --------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Read from storage without a persistent cache. | `defineCanon` from `headcanon`                   | Validates revisions and constructs the canon.                                                |
| Read inside a Next.js `"use cache"` function. | `defineCachedCanon` from `headcanon/next/server` | Validates revisions, constructs the canon, and tags the cache entry for every observed axis. |

Neither helper reads the database, checks permissions, or creates revisions. Your loader owns those steps. `defineCachedCanon` is asynchronous and must run inside a supported Next.js cache scope.

## Load one note

Read the data and its revision together, check access, then construct the canon:

```ts
// lib/notes/load.ts
import "server-only"

import { requireActor } from "@/lib/auth"
import { db } from "@/lib/db"
import { notes } from "@/lib/db/schema"
import { and, eq } from "drizzle-orm"
import { defineCanon } from "headcanon"
import { notFound } from "next/navigation"

import { noteAxis, type NoteState } from "./protocol"

export async function loadNoteCanon(noteId: string) {
  const actor = await requireActor()
  const [note] = await db
    .select()
    .from(notes)
    .where(and(eq(notes.id, noteId), eq(notes.ownerId, actor.userId)))

  if (!note) notFound()

  return defineCanon<NoteState>({
    value: { id: note.id, title: note.title },
    revisions: { [noteAxis(note.id)]: note.revision },
  })
}
```

`value` is the complete state expected by the predictor. Return only fields the client may see. A successful mutation does not authorize later reads; loaders must enforce their own access policy.

`revisions` describes the storage state used to build that value. The helper requires non-empty axis names and non-negative safe-integer revisions. An invalid revision throws because it indicates a loader or storage error. The helper does not validate the shape of `value` or prove that it matches the revisions.

`defineCanon` does not change Next.js route caching or force request-time execution. In this example, `requireActor()` reads the request's session. Keep this loader out of persistent caches unless you use the cached pattern below.

## Pass fresh canon to the client

Pass each server render's canon directly to the editor from Getting started. This route also places the request-dependent work behind a Suspense boundary, ready for Cache Components:

```tsx
// app/notes/[id]/page.tsx
import { loadNoteCanon } from "@/lib/notes/load"
import { Suspense } from "react"

import { NoteEditor } from "./note-editor"

type NotePageProps = {
  params: Promise<{ id: string }>
}

export default function NotePage({ params }: NotePageProps) {
  return (
    <Suspense fallback={<p>Loading note…</p>}>
      <NoteContent params={params} />
    </Suspense>
  )
}

async function NoteContent({ params }: NotePageProps) {
  const { id } = await params
  const canon = await loadNoteCanon(id)

  return <NoteEditor key={id} canon={canon} />
}
```

With Cache Components enabled, request-time reads belong beneath a Suspense boundary. See [Next.js caching](https://nextjs.org/docs/app/getting-started/caching) for the framework's rendering rules.

Inside the editor, pass the latest prop to `useNote({ canon })`. Do not preserve the initial canon in `useState`: that would prevent later server renders from reaching the root. Render the root's `value` to include pending predictions.

Key the editor or shared provider by the note's identity, not its revision. A new revision should update the existing root; remounting it discards its pending queue and settles unfinished receipts as unmounted.

## Keep values and revisions consistent

A canon must describe one consistent database snapshot. Reading a title from revision 7 and then reading revision 8 in a separate query can falsely claim that the older title includes the latest write. Headcanon trusts the revision and may remove a prediction too soon.

For a single row, select the value and revision in the same query, as above. For views built from several queries, use a read strategy that guarantees a shared snapshot across those queries. Merely placing separate queries in a default transaction does not establish that guarantee.

Do not attach a fresh revision to an older cached value, use the highest revision returned by unrelated queries, or substitute an accepted stamp for an actual read. An accepted stamp says what committed; it does not prove that your loader has observed that commit.

Treat the returned value as immutable on the client. Changes belong in mutation predictors and server commands.

## Choose axes that describe the view

An **axis** is a stable name for an independently advancing revision. It can represent one record or a collection. Your storage model defines it; Headcanon does not infer dependencies from SQL queries.

| View                                              | Possible axis                    | When to advance it                                                          |
| ------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------- |
| One note                                          | `notes/<noteId>`                 | Whenever a write changes the note's tracked state.                          |
| A workspace's note list                           | `workspaces/<workspaceId>/notes` | Whenever a write changes the list's membership, order, or displayed fields. |
| A view combining note data and workspace settings | Both the note and settings axes  | Advance each affected axis in the transaction that changes it.              |

These names are examples, not package conventions. Use the same helper in loaders and commands. Include tenant identity when record IDs are not globally unique; receipt scope does not automatically namespace axes.

Every writer must persist the new revision with its data changes. This includes imports, administrative tools, and background jobs. Do not reset a revision or reuse an axis for unrelated data.

### Lists, empty results, and deletion

A list that observes only the axes of its current rows cannot detect an inserted row through a subscription to those axes. Deleting a row also removes the place where its latest revision was stored.

A durable collection revision can describe membership changes and remains available when the list is empty. Read it with the list in one consistent snapshot. Every write that changes the list must advance that revision; if the list displays note titles, renames must advance it too.

For a detail view that remains mounted after deletion, retain a revision record or tombstone so the loader can return the deleted state with its confirming revision. Returning `notFound()` instead ends that view; it does not deliver a confirming canon to its mounted root.

## Know when canon confirms a mutation

A canon **covers** an accepted stamp only when it contains every axis in that stamp at the accepted revision or later.

Suppose a command accepts these revisions:

```text
notes/a: 8
workspaces/w/notes: 12
```

| Revisions returned by the loader       | Covers the stamp?                           |
| -------------------------------------- | ------------------------------------------- |
| `notes/a: 8`, `workspaces/w/notes: 12` | Yes.                                        |
| `notes/a: 9`, `workspaces/w/notes: 14` | Yes. Later revisions also cover the change. |
| `notes/a: 8`, `workspaces/w/notes: 11` | No. The collection revision is behind.      |
| `notes/a: 8`                           | No. The collection axis is missing.         |

Design a mutating root's loader to observe every axis its commands can stamp, even when some revisions do not have a directly displayed field. Do not omit stamped axes just to make a smaller payload. Conversely, do not invent observed revisions for data the loader has not read consistently.

Once an accepted mutation's stamp is covered, the root stops applying its prediction and its Canonization milestone succeeds (the receipt's `canonized` promise). Other pending mutations can still remain.

For diagnostics, use `covers(canon.revisions, stamp.revisions)`, `revisionAt`, and `revisionEntries` from `headcanon`. Revision vectors are opaque: do not index them directly or cast a plain object into one.

## Cache a loader in Next.js

Enable Cache Components in your existing Next.js configuration:

```ts
// next.config.ts
import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  cacheComponents: true,
}

export default nextConfig
```

Keep session reads outside `"use cache"`. Pass trusted, serializable identifiers to the cached function; its arguments become part of the cache key. See the [Next.js `use cache` reference](https://nextjs.org/docs/app/api-reference/directives/use-cache).

Replace the uncached loader with this version. It checks current ownership before reading cached data and includes the viewer's ID in the cache key:

```ts
// lib/notes/load.ts
import "server-only"

import { requireActor } from "@/lib/auth"
import { db } from "@/lib/db"
import { notes } from "@/lib/db/schema"
import { and, eq } from "drizzle-orm"
import { defineCachedCanon } from "headcanon/next/server"
import { cacheLife } from "next/cache"
import { notFound } from "next/navigation"

import { noteAxis, type NoteState } from "./protocol"

export async function loadNoteCanon(noteId: string) {
  const actor = await requireActor()
  const [access] = await db
    .select({ id: notes.id })
    .from(notes)
    .where(and(eq(notes.id, noteId), eq(notes.ownerId, actor.userId)))

  if (!access) notFound()

  return readCachedNoteCanon(noteId, actor.userId)
}

async function readCachedNoteCanon(noteId: string, userId: string) {
  "use cache"

  cacheLife("minutes")

  const [note] = await db
    .select()
    .from(notes)
    .where(and(eq(notes.id, noteId), eq(notes.ownerId, userId)))

  if (!note) notFound()

  return defineCachedCanon<NoteState>({
    value: { id: note.id, title: note.title },
    revisions: { [noteAxis(note.id)]: note.revision },
  })
}
```

The permission query deliberately remains outside the cache, so a cache hit cannot replace a current ownership check. Keep the cached helper private to the module and use the checked loader from routes. Adapt the access query to your actual permission model. Next.js also documents [authentication with Cache Components](https://nextjs.org/docs/app/guides/authentication-with-cache-components).

For this small note, caching may save little work. The pattern is more useful when the permitted view is expensive to build but its access check is inexpensive.

`defineCachedCanon` registers one derived cache tag for each axis in `revisions`. The generated Server Action expires the tags for the axes it accepted, so tagged readers can reload. `cacheLife` sets a lifetime policy; Headcanon's axis tags connect writes to cached reads.

Cache tags are not permissions, and a viewer-specific cache key does not replace authorization. All writers must also invalidate the affected cached views when their data changes.

### Cache tag limits

`defineCachedCanon` rejects more than 128 axes with a `RangeError` before registering tags. Account for other tags and nested cached work in the same entry too. Next.js documents its tag limits in the [`cacheTag` reference](https://nextjs.org/docs/app/api-reference/functions/cacheTag).

For large collections, consider a collection axis with a persisted revision rather than one tag per row. The collection revision must actually track every relevant change; it cannot simply be the maximum revision among its rows.

If you manage tags yourself, use the asynchronous `axisCacheTag(axis)` helper from `headcanon/next/server`. A raw axis name is not the cache tag that generated actions expire.

## Refresh after writes

After acceptance, a generated Server Action runs optional finalization, expires the affected axis tags, requests a route refresh, and publishes realtime invalidations when configured. The Next client root gives the action response a short grace period to bring back fresh canon before requesting its own refresh.

Refreshing a route does not by itself prove that the read has caught up. The loader must return covering revisions. Accepted predictions remain visible while the root waits, including when freshness becomes stalled.

For writes outside generated actions, persist the data and revisions first, then announce the committed stamp using the helper for your server context:

| Write context                               | Helper from `headcanon/next/server` | What it does                                                                      |
| ------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------- |
| Another Server Action                       | `finalizeExternalActionCommit`      | Expires axis tags, refreshes the invoking route, and publishes invalidations.     |
| A Route Handler, such as a webhook endpoint | `announceExternalCommit`            | Expires axis tags and publishes invalidations without requesting a route refresh. |

Both helpers take the committed `stamp`, an invalidation publisher, and a publication failure reporter. Unlike the generated action, they require both. Without a realtime transport, pass a publisher that does nothing, such as `{ publish() {} }`, and a reporter such as `console.error`. They do not perform the write or make a separate commit atomic. They use Next.js cache APIs, so run them in a supported Next.js server context; an independent worker needs a handoff to that context. Use `acceptedStamp` to validate a stamp received across a storage or transport boundary.

## Diagnose data that stays behind

| Symptom                                                 | What to check                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status.stallReason` is `"missing-axis"`.               | Compare `status.missingAxes` with the command's stamped axes. The loader must observe all of them.                                                                                                                                                                                                                                                                                                                  |
| `status.stallReason` is `"behind"`.                     | Check persisted revisions, cache tags, read-replica delay, and whether refreshed props reach the root.                                                                                                                                                                                                                                                                                                              |
| `status.stallReason` is `"refresh-error"`.              | Inspect failures reported by the refresh adapter. This reason means every attempt in the refresh budget failed; an error thrown while rendering a route may instead reach Next.js's error boundary. It comes from carriers that return a promise, such as `useSnapshotRefresh`. The default router carrier gives Headcanon no failure signal; in the browser, a failed router refresh reloads the page (see below). |
| A prediction disappears before the saved value appears. | Look for a newer revision paired with older data, or a loader that claims revisions it has not observed.                                                                                                                                                                                                                                                                                                            |
| A deleted item remains predicted.                       | Check how the loader retains the deletion's revision or returns a collection revision that covers it.                                                                                                                                                                                                                                                                                                               |
| The page loses pending edits on each refresh.           | Check that the root is keyed by record identity, not by revision or a changing render key.                                                                                                                                                                                                                                                                                                                          |

`stallReason` exists only when `status.freshness === "stalled"`. Use `retryRefresh()` or the `onFreshnessStalled` recovery listener to offer a retry. Do not increase reported revisions just to clear a stall.

With the default router adapter, a refresh attempt completes when the root receives changed state or revisions. The router gives Headcanon no failure signal, so in the root's status a refresh that never delivers new canon stays `"refreshing"`. The stall status is not a deadline for every possible Next.js failure.

### A failed router refresh reloads the page

In the browser, a failed `router.refresh()` does not stay pending. In Next.js 16.1, when the refresh request fails, the router falls back to a full-page load of the current URL. This happens when the network is down, when the server answers with an error status, and when a new deployment has replaced the build.

A reload loses all in-memory state: the root's mutation queue, including mutations the server has not accepted yet, and every open draft or unsaved input. If the browser is offline, the reload can show the browser's own offline error page instead of your app.

To keep the queue, give the root `persistence`. The reloaded page restores the mutations the server has not accepted and delivers them again. See [Keep the queue across a reload](react.md#keep-the-queue-across-a-reload). Drafts that were never passed to `mutate` are still lost.

This is common on a phone that loses signal. Polling makes it more likely, because `withPollingFallback` refreshes on each interval while push delivery is degraded. To lower the risk, `withPollingFallback` and `withVisibilityRefresh` do not request a refresh while the browser reports it is offline (`navigator.onLine === false`); they request one when the browser is online again. See [Realtime updates](realtime.md#add-polling-fallback). `navigator.onLine` is only a hint, so a refresh can still fail.

Later Next.js versions add an `experimental.useOffline` option. With it, the router waits for the connection and tries again instead of reloading. Headcanon is still verifying this option, so this guide does not recommend it yet.

If your app cannot afford a reload, load the data on the client and refresh it with the snapshot carrier, `useSnapshotRefresh`. A refetch that fails rejects its promise, the root counts a failed attempt, and the page stays mounted. See [React usage](react.md#use-react-without-the-next-binding).

## Further reading

- [Getting started](getting-started.md) — the complete note editor.
- [Server setup](server-setup.md) — guarded writes, accepted stamps, and finalization.
- [React usage](react.md) — planned guide to root lifetime and recovery controls.
- [Realtime updates](realtime.md) — planned guide to changes from other clients.
