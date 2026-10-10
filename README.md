# Headcanon

Optimistic mutations for Next.js: believe your writes until canon says otherwise.

Headcanon makes your app respond immediately while changes save on the server. You define how an update should look; Headcanon keeps that prediction visible until fresh server data confirms it, or removes it if the server refuses it.

It handles ordered delivery, safe retries, and pending updates when newer server data arrives. Your application controls validation, permissions, and database writes.

## Why Headcanon?

Making a button feel instant is easy. Keeping the screen correct while changes save is harder.

What happens when someone makes another edit before the first one finishes? When fresh server data arrives while edits are pending? When a request loses its connection, but the server may already have saved the change?

Headcanon handles those cases:

- **Keep edits visible.** Pending changes stay on screen while server data catches up.
- **Handle overlapping edits.** Mutations are sent in order, and pending changes are reapplied to newer server data.
- **Retry safely.** Stored receipts prevent a retried mutation from applying the same change twice.
- **Handle refusals.** Rejected changes are removed, with typed results your app can use to explain what happened.
- **Know when a change is complete.** Track both when the server saves it and when the screen receives confirmed data.
- **Save writes you cannot predict.** An operation, such as creating a record whose ID the server makes, gets the same receipts: a resent request returns the first result. See [Run an operation outside a protocol](docs/server-setup.md#run-an-operation-outside-a-protocol).

Use Headcanon when your Next.js app needs optimistic updates across Server Actions, database writes, and refreshed page data—and you want a consistent way to coordinate them.

## Install

```sh
npm install headcanon
```

Requires Node.js 22+, Next.js `^16.1.6`, and React `^19.2.4`.

Optional integrations:

- **Drizzle + Postgres** for transactional writes and stored mutation receipts.
- **Ably** for live updates across clients.

Install `drizzle-orm` or `ably` only if you use those integrations.

## Set up

Headcanon connects three parts of your application: shared mutation definitions, server commands, and a React view.

### 1. Define a mutation

A mutation describes its inputs and how it changes the displayed state. Group your mutations into a protocol shared by the browser and server.

This example uses Zod for validation and `serializable-result` for results:

```sh
npm install zod serializable-result
```

```ts
// lib/notes/protocol.ts
import { defineMutation, defineProtocol } from "headcanon"
import { ok } from "serializable-result"
import { z } from "zod"

export type NoteState = {
  id: string
  ownerId: string
  title: string
}

export const renameNote = defineMutation({
  name: "notes.rename",
  args: z.object({ title: z.string().min(1) }),
  predict: (state: NoteState, args) => ok({ ...state, title: args.title }),
})

export const notesProtocol = defineProtocol({
  id: "notes.v1",
  mutations: [renameNote],
})
```

Keep this module safe to import in the browser. Database code and authentication belong on the server.

### 2. Connect the server

Use `createMutationBinder` from `headcanon/server` and
`createNextMutationAction` from `headcanon/next/server` to connect the protocol
to your application.

Your server setup must:

- Identify the signed-in user and check permission to make the change.
- Bind each mutation to a command that validates and saves it.
- Record the revisions changed by each successful write.
- Export the generated Server Action for the client.

The included Drizzle adapter stores mutation receipts with your writes so retries do not apply the same mutation twice. Add `headcanonMutationReceipts` from `headcanon/drizzle-schema` to your Drizzle schema and run your normal migrations.

See [Server setup](docs/server-setup.md) for the complete database and command example.

### 3. Load the initial state

Return your data and its revisions with `defineCanon`, or use `defineCachedCanon` for a cached Next.js loader. Pass that result to your client component as `canon`.

**Canon** is Headcanon's name for confirmed server data. Its revisions let Headcanon tell when a saved change has reached the screen.

See [Loading data](docs/loading-data.md) for revision tracking and caching.

## Basic usage

Connect your protocol and generated Server Action once, outside the component:

```tsx
"use client"

import type { Canon } from "headcanon"
import { createNextPredictedRoot } from "headcanon/next/client"

import { applyNotesMutation } from "./actions"
import { notesProtocol, renameNote, type NoteState } from "./protocol"

const useNote = createNextPredictedRoot({
  protocol: notesProtocol,
  scope: (canon) => canon.value.ownerId,
  action: applyNotesMutation,
})

export function Note({ canon }: { canon: Canon<NoteState> }) {
  const { value, mutate } = useNote({ canon })

  return (
    <section>
      <h1>{value.title}</h1>
      <button onClick={() => mutate(renameNote({ title: "Chapter Two" }))}>
        Rename
      </button>
    </section>
  )
}
```

The title changes immediately. Headcanon sends the mutation to the server and keeps the predicted title visible until refreshed data includes the saved change.

Each hook call creates an independent mutation queue. To share one across several components, use `createPredictedRootContext`.

When you need feedback or follow-up work, pass `onPrediction`, `onAcceptance`, or `onCanonization` to `mutate`:

- **Prediction:** the local update was allowed or refused.
- **Acceptance:** the server accepted or refused the change, or delivery ended with a terminal failure.
- **Canonization:** confirmed server data now includes the change, or the mutation ended with a failure.

Recovery listeners let you show retry controls when delivery is uncertain or refreshed data falls behind.

## Entry points

Import each part of Headcanon from the entry for where your code runs. Each entry's full API documentation is the JSDoc in its shipped types; your editor shows it on hover.

| Entry                      | Use it in                                        | Main exports                                                                                                                      |
| -------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `headcanon`                | Shared code for the browser and server           | `defineMutation`, `defineProtocol`, `defineOperation`, `defineCanon`, `defineAxis`, `acceptedStamp`, `withPollingFallback`        |
| `headcanon/next/client`    | Next.js client components                        | `createNextPredictedRoot`, `createNextObservedRoot`, `createNextOperationHook`, `useRouterRefresh`                                |
| `headcanon/react`          | React client components without the Next binding | `createPredictedRoot`, `createPredictedRootContext`, `createObservedRoot`, `useSnapshotRefresh`                                   |
| `headcanon/server`         | Server commands, with or without Next.js         | `createMutationBinder`, `acceptMutation`, `acceptOperation`, `refuseMutation`, `denyMutation`, `allowScreening`, `allowAdmission` |
| `headcanon/next/server`    | Next.js Server Actions and loaders               | `createNextMutationAction`, `createNextOperationAction`, `defineCachedCanon`, `axisCacheTag`, `finalizeExternalActionCommit`      |
| `headcanon/drizzle`        | The server, with Drizzle and Postgres            | `createDrizzleMutationAuthority`, `matchesPostgresError`                                                                          |
| `headcanon/drizzle-schema` | Your Drizzle schema                              | `headcanonMutationReceipts`                                                                                                       |
| `headcanon/ably/channels`  | Shared Ably configuration                        | `ablyChannelNamespace`                                                                                                            |
| `headcanon/ably/client`    | The browser, with Ably                           | `createAblyAxisInvalidations`                                                                                                     |
| `headcanon/ably/server`    | The server, with Ably                            | `createAblyInvalidationPublisher`, `createAblyAxisTokenRequest`                                                                   |
| `headcanon/testing`        | Tests                                            | `createInMemoryMutationAuthority`, `createInMemoryInvalidationAdapter`                                                            |
| `headcanon/testing/react`  | Tests with Vitest and Testing Library            | `verifyRefreshContract`                                                                                                           |

## Further reading

- [Getting started](docs/getting-started.md) — a complete working feature.
- [Server setup](docs/server-setup.md) — authentication, commands, and Drizzle.
- [Loading data](docs/loading-data.md) — revisions, loaders, and caching.
- [React usage](docs/react.md) — shared state, feedback, and recovery.
- [Realtime updates](docs/realtime.md) — Ably and polling fallback.
- [Testing](docs/testing.md) — test helpers and the refresh adapter contract.
