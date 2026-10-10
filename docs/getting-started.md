# Getting started

Build a note editor that updates immediately, saves through a Next.js Server Action, and keeps the predicted title visible until confirmed server data arrives.

This guide uses Drizzle with Postgres. It assumes your application already has:

- Next.js App Router, TypeScript, and Node.js 22+.
- A Drizzle database connection exported as `db` from `@/lib/db`.
- A server-side `requireActor()` helper exported from `@/lib/auth`. It returns `{ userId: string }` for the signed-in user and redirects unauthenticated visitors.
- The `@/` import alias pointing to your application source.

Your Drizzle client must support interactive transactions, such as `drizzle-orm/node-postgres`. HTTP-only drivers, such as Neon over HTTP, do not work; for Neon, use its WebSocket `Pool`.

## 1. Install the packages

```sh
npm install headcanon drizzle-orm zod serializable-result
```

Headcanon requires Next.js `^16.1.6` and React `^19.2.4`. This example uses Zod to describe mutation inputs and `serializable-result` to return success or failure.

## 2. Prepare the database

Add a notes table and Headcanon's receipt table to your Drizzle schema:

```ts
// lib/db/schema.ts
import { integer, pgTable, text, uuid } from "drizzle-orm/pg-core"

export { headcanonMutationReceipts } from "headcanon/drizzle-schema"

export const notes = pgTable("notes", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerId: text("owner_id").notNull(),
  title: text("title").notNull(),
  revision: integer("revision").notNull().default(0),
})
```

Generate and apply migrations through your existing Drizzle workflow. Make sure its schema configuration includes this file.

Each note has a revision number. Every change to the note must increase that number in the same transaction as the write.

Headcanon's receipt table records mutation outcomes. If a client retries a request, the server can return the recorded outcome without applying the change again.

Create a note owned by your test user through your application or seed script. You will use its ID to open the editor.

## 3. Define the mutation

Create a module that both the browser and server can import:

```ts
// lib/notes/protocol.ts
import { defineAxis, defineMutation, defineProtocol } from "headcanon"
import { err, ok } from "serializable-result"
import { z } from "zod"

export type NoteState = {
  id: string
  ownerId: string
  title: string
}

export const noteAxis = defineAxis("notes", z.uuid())

export function isValidTitle(title: string) {
  return title.trim().length > 0 && title.length <= 200
}

export const renameNote = defineMutation({
  name: "notes.rename",
  args: z.object({
    noteId: z.uuid(),
    title: z.string(),
  }),
  refusal: z.literal("invalid-title"),
  predict(state: NoteState, args) {
    if (!isValidTitle(args.title)) {
      return err("invalid-title" as const)
    }

    return ok({ ...state, title: args.title })
  },
})

export const notesProtocol = defineProtocol({
  id: "notes.v1",
  mutations: [renameNote],
})
```

The mutation defines its inputs, public refusal values, and a **predictor**: a function that calculates the state the user should see immediately.

Keep the predictor pure. It can run again when newer server data arrives, so it must not write data, make requests, or produce side effects.

The protocol's state type comes from its predictors. A protocol with no mutations yet has no predictor to read it from, so declare the state yourself: `defineProtocol<NoteState>()({ id: "notes.v1", mutations: [] })`. The root and the action then work with an empty list, and each mutation you add later must predict `NoteState`.

`noteAxis` is an **axis family**. `noteAxis.of(noteId)` gives each note a stable address, `notes/<noteId>`, for revision tracking. The server write and data loader must use the same address. `of` throws if the ID is not a UUID. `noteAxis.parse(axis)` reads the note ID back from an address; [Realtime](realtime.md) uses it to check the axes a browser asks for.

## 4. Connect Headcanon to your server

Create a binder that connects your database to the signed-in user:

```ts
// lib/notes/binder.ts
import "server-only"

import { requireActor } from "@/lib/auth"
import { db } from "@/lib/db"
import { createDrizzleMutationAuthority } from "headcanon/drizzle"
import { createMutationBinder } from "headcanon/server"

const authority = createDrizzleMutationAuthority({
  db,
  scope: (actor: { userId: string }) => actor.userId,
})

export const notesBinder = createMutationBinder({
  actor: requireActor,
  authority,
})
```

The authority handles transactions and stored receipts. Its scope identifies whose receipts belong together; it does not grant permission to edit a note.

The server derives the user's identity from `requireActor()`. The browser never supplies it.

## 5. Implement the Server Action

Bind the mutation to a command that checks ownership, validates the title, and saves the change:

```ts
// lib/notes/actions.ts
"use server"

import { notes } from "@/lib/db/schema"
import { and, eq } from "drizzle-orm"
import { createNextMutationAction } from "headcanon/next/server"
import {
  acceptMutation,
  allowAdmission,
  allowScreening,
  denyMutation,
  refuseMutation,
  throwMutationContention,
} from "headcanon/server"

import { notesBinder } from "./binder"
import { isValidTitle, noteAxis, notesProtocol, renameNote } from "./protocol"

export const applyNotesMutation = createNextMutationAction({
  protocol: notesProtocol,
  binder: notesBinder,
  commands: [
    notesBinder.bind(renameNote, {
      screen: async ({ executor, actor, args }) => {
        const [note] = await executor
          .select({ id: notes.id })
          .from(notes)
          .where(
            and(eq(notes.id, args.noteId), eq(notes.ownerId, actor.userId))
          )

        return note ? allowScreening() : denyMutation()
      },

      admit: async ({ tx, actor, args }) => {
        const [note] = await tx
          .select()
          .from(notes)
          .where(
            and(eq(notes.id, args.noteId), eq(notes.ownerId, actor.userId))
          )

        return note ? allowAdmission(note) : denyMutation()
      },

      execute: async ({ tx, actor, args, evidence, stamp }) => {
        if (!isValidTitle(args.title)) {
          return refuseMutation("invalid-title")
        }

        const nextRevision = evidence.revision + 1

        const [updated] = await tx
          .update(notes)
          .set({
            title: args.title,
            revision: nextRevision,
          })
          .where(
            and(
              eq(notes.id, args.noteId),
              eq(notes.ownerId, actor.userId),
              eq(notes.revision, evidence.revision)
            )
          )
          .returning({ id: notes.id })

        if (!updated) {
          throwMutationContention()
        }

        stamp.record(noteAxis.of(args.noteId), nextRevision)
        return acceptMutation()
      },
    }),
  ],
})
```

The command has three stages:

- **`screen`** checks access before Headcanon looks up or creates a receipt.
- **`admit`** checks access again inside the transaction and passes the current note to `execute` as `evidence`.
- **`execute`** saves the title and records the new revision.

`screen` and `admit` protect different moments. In this example both check ownership, but `screen` controls access to the request's outcome and `admit` controls the write.

`screen` runs on every delivery, including a retry that would return a stored receipt. This checks access before Headcanon returns an old result.

`admit` runs at the start of each new transaction attempt, including a retry after contention. Data or permissions may have changed since screening, so the write needs this fresh check.

The update checks the revision it read. If another write changes the note first, `throwMutationContention()` asks Headcanon to retry the transaction against current data.

Keep writes inside `tx`. Commands can run more than once during contention recovery, so avoid sending emails or making other external changes inside them.

## 6. Load confirmed data

Headcanon calls confirmed server data **canon**. It contains the displayed value and the revisions read with that value.

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
    value: {
      id: note.id,
      ownerId: note.ownerId,
      title: note.title,
    },
    revisions: {
      [noteAxis.of(note.id)]: note.revision,
    },
  })
}
```

This query reads the title and revision together. Headcanon uses that revision to determine whether the loaded data includes a saved mutation.

For this guide, the loader reads directly from the database. Cached loaders use `defineCachedCanon`; see [Loading data](loading-data.md).

## 7. Build the editor

Connect the protocol and Server Action once, outside the component:

```tsx
// app/notes/[id]/note-editor.tsx
"use client"

import { applyNotesMutation } from "@/lib/notes/actions"
import { notesProtocol, renameNote, type NoteState } from "@/lib/notes/protocol"
import type { Canon } from "headcanon"
import { createNextPredictedRoot } from "headcanon/next/client"
import { useState } from "react"

const useNote = createNextPredictedRoot({
  protocol: notesProtocol,
  scope: (canon) => canon.value.ownerId,
  action: applyNotesMutation,
})

export function NoteEditor({ canon }: { canon: Canon<NoteState> }) {
  const { value, mutate } = useNote({ canon })
  const [title, setTitle] = useState(canon.value.title)
  const [error, setError] = useState<string | null>(null)

  function rename() {
    setError(null)

    mutate(renameNote({ noteId: value.id, title }), {
      onPrediction(result) {
        if (!result.ok) {
          setError("Enter a title between 1 and 200 characters.")
        }
      },
      onAcceptance(result) {
        if (!result.ok) {
          setError("The change could not be saved.")
        }
      },
    })
  }

  return (
    <section>
      <h1>{value.title}</h1>

      <label htmlFor="note-title">Title</label>
      <input
        id="note-title"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
      />

      <button type="button" onClick={rename}>
        Rename
      </button>

      {error && <p role="alert">{error}</p>}
    </section>
  )
}
```

Render it from the route:

```tsx
// app/notes/[id]/page.tsx
import { loadNoteCanon } from "@/lib/notes/load"

import { NoteEditor } from "./note-editor"

export default async function NotePage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const canon = await loadNoteCanon(id)

  return <NoteEditor key={id} canon={canon} />
}
```

`scope` returns the receipt scope of the signed-in user: the same value as the authority's `scope(actor)`. The loader only reads the user's own notes, so the note's `ownerId` is that user's ID. Every mutation carries this scope, and the server action denies a mutation whose scope is not the current user's. A change made before a sign-out therefore never runs as the next user.

The component reads `value` from Headcanon. That value includes pending predictions over the latest confirmed data.

The `key` gives each note its own mounted mutation queue when navigating between notes.

## 8. Try it

Start your application and open `/notes/<your-note-id>`.

1. Enter a new title and select **Rename**. The heading changes immediately.
2. Reload the page. The saved title remains.
3. Try an empty title. The predictor refuses it and the editor shows an error.
4. Make two valid edits quickly. Headcanon sends them in order and keeps pending changes visible as server data arrives.

A successful change passes through three milestones:

| Milestone    | Meaning                                    |
| ------------ | ------------------------------------------ |
| Prediction   | The local update is allowed and displayed. |
| Acceptance   | The server has committed the change.       |
| Canonization | Refreshed server data includes the change. |

The generated Server Action requests a route refresh after acceptance. The client keeps the prediction until the returned canon reaches the recorded revision.

## Next steps

This example covers a successful save and basic refusal feedback. Before shipping, add recovery listeners so users can retry uncertain delivery or stalled refreshes.

Read these guides next:

- [React usage](react.md) — recovery controls, mutation milestones, and sharing a root across components.
- [Server setup](server-setup.md) — command policies, transaction limits, and receipt management.
- [Loading data](loading-data.md) — caching and tracking revisions across larger views.
- [Realtime updates](realtime.md) — receiving changes made by other clients.
- [Testing](testing.md) — testing predictions and server behavior.
