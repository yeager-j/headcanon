# Server setup

Headcanon connects shared mutation definitions to server commands that check permissions and save changes for the signed-in user. The Drizzle adapter handles transactions, retries, and stored mutation receipts. Your commands supply the application rules.

This guide builds on the note editor in [Getting started](getting-started.md). It uses the same `db`, `requireActor`, notes table, and shared protocol. Start there for the complete client and server example.

## Prepare your database

Install the Drizzle integration if your application does not already use it:

```sh
npm install drizzle-orm
```

The adapter supports Postgres clients with interactive transactions, such as `drizzle-orm/node-postgres`. HTTP-only query clients are not supported. For Neon, use its WebSocket `Pool` integration.

Add Headcanon's receipt table to a schema file included by your migration configuration:

```ts
// lib/db/schema.ts
export { headcanonMutationReceipts } from "headcanon/drizzle-schema"

// Keep your application's table definitions here too.
```

Generate and deploy the table through your normal Drizzle migration workflow before serving mutations. Headcanon does not create it at runtime. The package also includes `drizzle/0000_headcanon_mutation_receipts.sql` as a baseline for migration review.

Use `headcanon/drizzle-schema` in schema files and `headcanon/drizzle` in server code. The separate schema entry keeps the server execution code out of migration tooling.

## Create an authority and binder

An **authority** executes mutations against storage. A **binder** connects that authority to a function that identifies the current user and supplies typed context to each command.

Create them once at module level:

```ts
// lib/notes/binder.ts
import "server-only"

import { requireActor } from "@/lib/auth"
import { db } from "@/lib/db"
import { createDrizzleMutationAuthority } from "headcanon/drizzle"
import { createMutationBinder } from "headcanon/server"

const notesAuthority = createDrizzleMutationAuthority({
  db,
  scope: (actor: { userId: string }) => actor.userId,
})

export const notesBinder = createMutationBinder({
  actor: requireActor,
  authority: notesAuthority,
})
```

`requireActor()` runs for each valid delivery. It must derive identity from trusted server context, such as your session. Do not take the acting user's ID from mutation arguments.

`scope` provides a stable namespace for receipts. Headcanon identifies a receipt by the pair `(scope, mutationId)`. A user ID works when it uniquely identifies the actor across your application. If user IDs are only unique within a tenant, include both trusted IDs; for example, `JSON.stringify([actor.tenantId, actor.userId])`.

Receipt scope does not grant permission to read or write data. Commands still need to check access. Keep the scope stable across retries: changing it makes an existing receipt invisible to that request.

The binder module must not import command modules. Commands import the binder, and the action imports both.

## Bind your commands

Move a command into its own server module as a feature grows. This is the rename command from Getting started, using its existing shared mutation and schema:

```ts
// lib/notes/commands/rename-note.ts
import "server-only"

import { notes } from "@/lib/db/schema"
import { and, eq } from "drizzle-orm"
import {
  acceptMutation,
  allowAdmission,
  allowScreening,
  denyMutation,
  refuseMutation,
  throwMutationContention,
} from "headcanon/server"

import { notesBinder } from "../binder"
import { isValidTitle, noteAxis, renameNote } from "../protocol"

export const renameNoteBinding = notesBinder.bind(renameNote, {
  screen: async ({ executor, actor, args }) => {
    const [note] = await executor
      .select({ id: notes.id })
      .from(notes)
      .where(and(eq(notes.id, args.noteId), eq(notes.ownerId, actor.userId)))

    return note ? allowScreening() : denyMutation()
  },

  admit: async ({ tx, actor, args }) => {
    const [note] = await tx
      .select()
      .from(notes)
      .where(and(eq(notes.id, args.noteId), eq(notes.ownerId, actor.userId)))

    return note ? allowAdmission(note) : denyMutation()
  },

  execute: async ({ tx, actor, args, evidence, stamp }) => {
    if (!isValidTitle(args.title)) {
      return refuseMutation("invalid-title")
    }

    const nextRevision = evidence.revision + 1
    const [updated] = await tx
      .update(notes)
      .set({ title: args.title, revision: nextRevision })
      .where(
        and(
          eq(notes.id, args.noteId),
          eq(notes.ownerId, actor.userId),
          eq(notes.revision, evidence.revision)
        )
      )
      .returning({ id: notes.id })

    if (!updated) throwMutationContention()

    stamp.record(noteAxis(args.noteId), nextRevision)
    return acceptMutation()
  },
})
```

Write command members in lifecycle order: `screen`, `admit`, `execute`, then optional `finalizeAccepted`. TypeScript uses this order to infer `evidence` from `admit` and `screened` from `screen`.

`allowScreening(value)` passes `value` to `finalizeAccepted` as `screened`. `allowAdmission(value)` passes `value` to `execute` as `evidence`. Call either with no argument when the next step needs no value; it then receives `undefined`.

Command modules import from `headcanon/server`, which loads no Next.js code. A non-Next server, such as a Route Handler or a worker, can use the same binder and commands. Only the action module imports `headcanon/next/server`.

### Why screening and admission are separate

`screen` checks whether this delivery may proceed, including whether a retry may receive a stored outcome. It runs before receipt lookup and uses `executor` to read committed data outside the mutation transaction. A screening denial creates no receipt.

`admit` checks whether a new write attempt is allowed. It runs inside the transaction, uses `tx`, and runs again if contention forces another attempt. A stored outcome skips admission and execution, but still passes through screening.

The ownership checks look similar because they protect different moments. Access may have changed since the original request or since screening. Do not use a successful screen as a substitute for transaction-time authorization.

Admission alone does not lock the data it reads. The example also checks ownership and revision in its update. If permissions live in other tables, your transaction must protect those decisions with suitable locks or guarded writes too.

### When to use Screen vs Admit

| Example                                                       | Use `screen` for                                                                                                 | Use `admit` for                                                                                                            |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| A user must belong to the note's workspace.                   | Check current membership before allowing a new request or returning a stored outcome.                            | Recheck membership inside each write attempt; protect the permission check against concurrent changes.                     |
| Only the owner may rename a note.                             | Check ownership before receipt lookup, as in the example above.                                                  | Read the owned note through `tx` and pass it to `execute`; keep the ownership and revision guards on the update.           |
| An order may be submitted only while it is a draft.           | Check access to the order. Do not require it to remain a draft just to recover an earlier successful submission. | Read its current status for a new attempt. Let `execute` return a public refusal if it is no longer a draft.               |
| A purchase needs enough stock.                                | Check whether the user may access the purchase operation.                                                        | Read stock through `tx` and pass it as evidence. Let `execute` reserve it with a guarded write or return a public refusal. |
| An update depends on a row's current revision.                | No revision check is needed just to return a stored result.                                                      | Read the revision used by `execute` to guard the write. A contention retry reads it again.                                 |
| A post-commit projection needs context from before the write. | Return that context with `allowScreening(...)` so `finalizeAccepted` receives it as `screened`.                  | Read any data needed for the write separately. Attempt evidence is not passed to finalization.                             |

Use both steps when a permission controls access to stored outcomes and new writes. Keep conditions that a successful mutation changes, such as an order's draft status, in the transaction path so they do not block recovery of that success. `admit` can allow or deny; public business-rule refusals belong in `execute`.

### Choose the right outcome

| Outcome                               | Use it for                                                                        | Receipt behavior                                                                                        |
| ------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `acceptMutation()`                    | A successful command.                                                             | Commits application writes and the accepted receipt together.                                           |
| `acceptMutation({ unchanged: true })` | A successful command that changes nothing, such as a rename to the current title. | Records an accepted receipt with an empty stamp. The client ends the prediction at once.                |
| `refuseMutation(error)`               | An expected business rule failure safe to explain to the caller.                  | Rolls back the attempt's writes and records the public refusal.                                         |
| `denyMutation()`                      | Missing access that should not expose a reason.                                   | Creates no receipt in `screen`; rolls back attempt writes and records a denial in `admit` or `execute`. |
| `throwMutationContention()`           | A concurrent change that requires a fresh attempt.                                | Rolls back the transaction and retries with a fresh stamp, up to `maxAttempts`.                         |
| An unexpected exception               | A database failure or programming error.                                          | Propagates without committing the attempt or a new receipt.                                             |

The generated action returns denials as `ok({ kind: "denied" })`, without a reason. `createNextPredictedRoot` maps that outcome to a terminal mutation failure. You do not need to throw Next.js `forbidden()` for this path.

Give a mutation a `refusal` schema when its command can return `refuseMutation(error)`. If the command has no public refusal cases, omit `refusal`: the mutation's refusal type is then `never`, and a stored refusal for it throws instead of replaying. Refusal schemas must validate synchronously, and their values must be JSON serializable. Keep secrets and internal error details out of public refusals.

The action validates arguments before deriving the actor or running commands. It does not run the client predictor on the server, so repeat all business rules needed for a valid write. Arguments must already be in their schema's parsed form; the action rejects parsing that changes them. Normalize inputs before creating the invocation.

## Export the Server Action

Keep the action module small:

```ts
// lib/notes/actions.ts
"use server"

import { createNextMutationAction } from "headcanon/next/server"

import { notesBinder } from "./binder"
import { renameNoteBinding } from "./commands/rename-note"
import { notesProtocol } from "./protocol"

export const applyNotesMutation = createNextMutationAction({
  protocol: notesProtocol,
  binder: notesBinder,
  commands: [renameNoteBinding],
})
```

Bind every mutation in the protocol exactly once, using that protocol's mutation definition objects and the same binder passed to the action. A different binder is rejected even if its types match.

Keep `commands` a fixed list. An inline list works; a list exported from another module should use `as const`. Put permission checks inside commands instead of conditionally adding or removing bindings.

## Write and stamp in one transaction

Use `tx` for all reads and writes in `admit` and `execute`. Using the outer `db` connection would put those operations outside the transaction Headcanon can roll back.

The Drizzle adapter runs at `READ COMMITTED`, regardless of the database default. It serializes deliveries with the same receipt identity, but different mutations can still change the same application rows. Protect those writes with revision checks, as the rename command does.

When a guarded update affects no row, call `throwMutationContention()`. The adapter discards the failed transaction and its stamp, then runs admission and execution again against current data. Do not catch this exception and turn it into a public refusal.

Record every revision the successful transaction advances with `stamp.record(axis, revision)`. Recording a stamp does not update your database: your command must persist the revision itself. If one command changes several independently tracked records, record each affected axis.

An accepted command must record at least one axis. If `execute` returns `acceptMutation()` with an empty stamp, the authority throws, rolls the transaction back, and records no receipt. Without this check, the client would end the prediction before refreshed data arrives, and the old value would show again. When a command accepts and changes nothing, return `acceptMutation({ unchanged: true })` and record no axis. A command that records an axis and also returns `unchanged: true` throws too.

Use stable axis names and increasing, non-negative safe integers. Loaders must read the displayed values and their revisions together. Missing or incorrect revisions can prevent the client from recognizing that a saved mutation has reached the screen.

## Configure contention retries

`createDrizzleMutationAuthority` defaults to two total attempts per execution, including the first. Set `maxAttempts` to a positive integer to change that limit:

```ts
const notesAuthority = createDrizzleMutationAuthority({
  db,
  scope: (actor: { userId: string }) => actor.userId,
  maxAttempts: 3,
})
```

The adapter already retries Postgres serialization failures, deadlocks, and lock-not-available errors. `isContentionError` can add application-specific cases. The exported `matchesPostgresError` helper matches a SQLSTATE and optional constraint name, including errors wrapped in `cause`.

Only classify an error as contention when rerunning against current data can resolve it. A business rule failure should usually become a public refusal instead.

If all attempts encounter contention, the authority returns a `contention` error without a new receipt. The Next client binding treats this as retryable delivery. The authority's attempt limit applies to one execution, not to the entire lifetime of a client mutation.

## Run work after acceptance

Most commands need no `finalizeAccepted`. The generated action already expires cache tags for the accepted axes and requests a refresh of the invoking route.

Use optional `finalizeAccepted` when readers depend on an application-owned projection that must be updated after the commit but before refresh. It receives `actor`, `args`, `stamp`, and the `screened` value returned by `allowScreening(...)`. It does not receive `tx` or the attempt's `evidence`.

After acceptance, the action runs these steps in order:

1. Run `finalizeAccepted`, if supplied.
2. Expire cache tags for the accepted axes.
3. Request a route refresh.
4. Publish realtime invalidations, if configured.

Finalization runs again when an accepted receipt is recovered on a later delivery. Make it safe to repeat, and prevent older accepted work from overwriting a newer projection. The `screened` value belongs to the current delivery, not necessarily to the original write.

If finalization throws, the database commit and receipt remain. The action still attempts cache invalidation, refresh, and realtime publication, then propagates the error. A retry can recover the receipt and rerun finalization without repeating the application write.

Do not treat finalization as a durable background job or a once-only hook. For external effects such as email, store a work item in the same transaction as the mutation and process it with a durable worker that can handle repeated delivery.

### Optional realtime publication

To notify other clients, supply an `invalidations` publisher to `createNextMutationAction`. Omit it when using route refresh alone.

The publisher owns its failure reporter: give `onFailure` to the publisher, such as `createAblyInvalidationPublisher`. Publication failures and timeouts are reported without changing an accepted outcome. The action waits up to one second for publication; it does not provide a durable publication retry queue. See the planned [Realtime updates](realtime.md) guide for transport setup and recovery.

## Bound database and network waits

Set database lock and statement timeouts, plus deadlines for any external calls, so a Server Action can answer within your deployment's request limit. Include time for contention retries when choosing those limits. Headcanon does not configure these deadlines for your application.

The client's delivery timeout marks the result as uncertain; it does not cancel the running Server Action. An unanswered Next.js action can hold up other actions and transitions. Bounded server work lets the client receive an answer or retry once the failed call has ended.

## Limit delivery age

Each envelope carries `createdAt`, the time the client created the mutation, in epoch milliseconds on the client's clock. A retry, a delivery at unmount, and a later redelivery all keep the original value. So does a mutation that a root restores from its stored queue after a page reload; see [Keep the queue across a reload](react.md#keep-the-queue-across-a-reload).

When no receipt exists for the mutation ID, the authority compares `createdAt` with its own clock before every attempt. The Drizzle adapter uses the database clock. It refuses the delivery when `createdAt` is:

| Condition                                             | Error code             | Default limit |
| ----------------------------------------------------- | ---------------------- | ------------- |
| Older than `maxDeliveryAgeMs`                         | `delivery-expired`     | 7 days        |
| More than `clockSkewToleranceMs` ahead of server time | `delivery-from-future` | 1 hour        |

A refused delivery runs no command and records no receipt. Screening still runs first. If a receipt already exists, the authority replays it, or returns `mutation-id-reused`, whatever the envelope's age. An old tab that retries a save that already committed learns that it was accepted.

Set the limits on the authority:

```ts
const notesAuthority = createDrizzleMutationAuthority({
  db,
  scope: (actor: { userId: string }) => actor.userId,
  maxDeliveryAgeMs: 7 * 24 * 60 * 60 * 1000,
  clockSkewToleranceMs: 60 * 60 * 1000,
})
```

Choose a maximum age longer than the longest time a user can leave a tab with an unsaved change and then retry it. Age counts from `mutate`, not from the first send, so mutations queued behind an uncertain one keep aging while they wait.

A client whose clock is wrong by more than these limits cannot save: a slow clock gets `delivery-expired`, and a fast clock gets `delivery-from-future`. Headcanon does not correct client clocks and never changes an envelope's `createdAt`.

> **Breaking change in 0.1.0.** `createdAt` is a required envelope field. The server rejects an envelope without it as `invalid-envelope` with reason `unexpected-fields`. Reload old clients after you deploy. Code that builds envelopes itself, such as tests or a custom sender, must add `createdAt: Date.now()`. A custom authority adapter must apply the delivery window; see [Verify custom adapters](testing.md#verify-custom-adapters).

## Delete old receipts

Receipts are part of the write guarantee. The adapter stores them in the same database transaction as accepted application changes and replays recorded refusals and denials too, after screening allows the delivery.

A retry must keep the same mutation ID, protocol, and arguments. Reusing an ID with a different invocation returns `mutation-id-reused`. The client root preserves the original envelope when retrying uncertain delivery.

`deleteExpiredReceipts()` deletes receipts that no honest redelivery can use. It deletes a receipt once it is older than `maxDeliveryAgeMs + clockSkewToleranceMs + marginMs` on the database clock. After that, every redelivery that keeps its original `createdAt` gets `delivery-expired`. `marginMs` defaults to 1 hour and covers database clock adjustments, such as a failover to a server whose clock differs.

Run it from a scheduled job. Each call deletes at most `limit` receipts (default 1000), oldest first, through the `created_at` index:

```ts
// app/api/cron/receipts/route.ts
import { notesAuthority } from "@/lib/notes/binder"

export async function GET() {
  let deleted: number
  do {
    deleted = await notesAuthority.deleteExpiredReceipts({ limit: 1000 })
  } while (deleted === 1000)

  return Response.json({ ok: true })
}
```

Export the authority from the binder module to use it there, and protect the route as your platform recommends for scheduled jobs. Several jobs or servers may run cleanup at the same time. A call skips receipts that a delivery has locked, so a short batch does not prove that no expired receipt remains; the next run deletes them.

Cleanup is safe only while the delivery window stays the same:

- Every authority that uses the receipt table, on every server and in every deployment, must use the same `maxDeliveryAgeMs` and `clockSkewToleranceMs` once cleanup runs. Several authorities with the same window may share the table.
- Do not run cleanup while any server without the delivery-age check can still accept deliveries.
- To change the window by more than `marginMs`, follow the matching transition:

| Change                            | Transition                                                                                                                       |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Lower `maxDeliveryAgeMs`          | Stop cleanup until every server runs the new value.                                                                              |
| Raise `clockSkewToleranceMs`      | Stop cleanup until every server runs the new value.                                                                              |
| Raise `maxDeliveryAgeMs` by Δ     | Stop cleanup. Wait Δ after the last cleanup run ends. Then deploy, and start cleanup again when every server runs the new value. |
| Lower `clockSkewToleranceMs` by Δ | From the start of the rollout until `maxDeliveryAgeMs` + the old tolerance + `marginMs` after it ends, add Δ to `marginMs`.      |

Without these steps, cleanup can delete a receipt that a server with the new window still needs. For example, a receipt deleted under a 1-day age lets a 7-day age execute the same envelope again.

A delivery-age refusal proves only that this delivery wrote nothing. After cleanup deletes a receipt, a mutation that committed but whose response was lost also gets `delivery-expired`. See [Handle terminal failures](react.md#handle-terminal-failures).

Keep stored refusal values readable across deployments for as long as their receipts exist. Replayed refusals are checked against the current mutation's refusal schema; incompatible or malformed stored outcomes throw instead of executing the mutation again.

## Further reading

- [Getting started](getting-started.md) — the complete note editor.
- [Loading data](loading-data.md) — planned guide to revisions, loaders, and caching.
- [React usage](react.md) — planned guide to feedback and delivery recovery.
- [Testing](testing.md) — planned guide to authority helpers and contract suites.
