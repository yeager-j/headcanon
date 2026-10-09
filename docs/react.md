# React usage

A Headcanon root combines confirmed server data with pending predictions. It owns the mutation queue, receipt milestones, refresh status, and recovery controls for one mounted view.

This guide uses the note protocol and Server Action from [Getting started](getting-started.md). See [Loading data](loading-data.md) for the `Canon<NoteState>` passed to the client.

## Create a root

For a Next.js App Router application, use `createNextPredictedRoot`. Configure the factory once, outside your components:

```ts
// lib/notes/root.ts
"use client"

import { createNextPredictedRoot } from "headcanon/next/client"
import { createPredictedRootContext } from "headcanon/react"

import { applyNotesMutation } from "./actions"
import { notesProtocol } from "./protocol"

export const useNote = createNextPredictedRoot({
  protocol: notesProtocol,
  action: applyNotesMutation,
})

export const NoteRoot = createPredictedRootContext(useNote, {
  name: "NoteRoot",
})
```

The Next binding supplies Server Action delivery and router refresh. A router refresh that fails reloads the whole page, which drops the root's queue and any unsaved drafts; see [Loading data](loading-data.md#a-failed-router-refresh-reloads-the-page). To keep the queue across a reload, see [Keep the queue across a reload](#keep-the-queue-across-a-reload). The binding also passes Next.js navigation signals, such as redirects, back to the framework instead of treating them as uncertain delivery.

The factory does not create a shared store. Each call to `useNote({ canon })` mounts an independent root. Use the hook directly when one component owns the feature, as in Getting started. Use `NoteRoot.Provider` when several components need the same state and queue.

## Share one root across components

Mount the provider over the feature, then use `NoteRoot.useRoot()` in its descendants:

```tsx
// app/notes/[id]/note-surface.tsx
"use client"

import { renameNote, type NoteState } from "@/lib/notes/protocol"
import { NoteRoot } from "@/lib/notes/root"
import type { Canon } from "headcanon"

export function NoteSurface({ canon }: { canon: Canon<NoteState> }) {
  return (
    <NoteRoot.Provider key={canon.value.id} canon={canon}>
      <NoteTitle />
      <RenameButton />
    </NoteRoot.Provider>
  )
}

function NoteTitle() {
  const { value } = NoteRoot.useRoot()
  return <h1>{value.title}</h1>
}

function RenameButton() {
  const { value, mutate } = NoteRoot.useRoot()

  return (
    <button
      type="button"
      onClick={() =>
        mutate(renameNote({ noteId: value.id, title: "Chapter Two" }))
      }
    >
      Rename
    </button>
  )
}
```

The title and button now use the same mounted root. Calling `useNote` separately in each component would create separate queues. `NoteRoot.useRoot()` throws when no matching provider exists above it.

Pass the latest `canon` prop through on every server render. Do not copy the initial canon into local state. Key the provider by the record's identity, not its revision, so a refresh updates the existing root rather than remounting it.

Render `value` from the root to show optimistic changes. Local React state still belongs in the component for unsent form drafts, open menus, and other interface state.

## Submit a mutation

Call `mutate` from an event handler with an invocation from your shared mutation definition:

```ts
// Inside a component that reads mutate and value from the root:
const result = mutate(renameNote({ noteId: value.id, title: "Chapter Two" }))

if (!result.ok) {
  // The predictor refused the change. Nothing was queued.
  console.info("Prediction refused:", result.error)
} else {
  // Local prediction succeeded; the server has not necessarily saved it.
  console.info("Queued mutation:", result.value.id)
}
```

`mutate` returns a synchronous `Result`. On success, its value is a receipt with an ID and two promises: `accepted` and `canonized`. You do not need to wrap the call in `startTransition`; Headcanon manages its delivery transitions.

The invocation factory takes parsed arguments but does not parse them itself. Validate or normalize raw form input before invocation when needed. The predictor can refuse local business-rule failures, and the server checks arguments and write policy independently.

Predictions apply in invocation order. Delivery waits for the preceding mutation's acceptance or terminal failure, not for its canonization. This lets users keep editing while confirmed data catches up.

## Choose the milestone your interface needs

| Milestone                                     | Successful result                                                  | Typical use                                                           |
| --------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `onPrediction` / the return value of `mutate` | A mutation receipt. The local change was allowed and queued.       | Show local validation feedback or clear a submitted draft.            |
| `onAcceptance` / `receipt.accepted`           | An `AcceptedStamp`. The server committed the change.               | Show a saved message or continue work that depends on the commit.     |
| `onCanonization` / `receipt.canonized`        | `void`. This root received canon covering every accepted revision. | Confirm that the saved change is included in this view's server data. |

A successful prediction is not a successful save. Acceptance and canonization can happen at different times, especially when refreshing data is slow.

### Use callbacks for feedback

This form can replace the fixed-title button in the shared surface:

```tsx
// app/notes/[id]/rename-form.tsx
"use client"

import { renameNote } from "@/lib/notes/protocol"
import { NoteRoot } from "@/lib/notes/root"
import { useState } from "react"

export function RenameForm() {
  const { value, mutate } = NoteRoot.useRoot()
  const [title, setTitle] = useState(value.title)
  const [message, setMessage] = useState<string | null>(null)

  function rename() {
    mutate(renameNote({ noteId: value.id, title }), {
      onPrediction(result) {
        setMessage(
          result.ok ? "Saving…" : "Enter a title between 1 and 200 characters."
        )
      },
      onAcceptance(result) {
        if (result.ok) {
          setMessage("Saved. Waiting for refreshed data…")
        } else if (result.error.kind === "domain") {
          setMessage("The server refused this title.")
        } else if (result.error.kind === "denied") {
          setMessage("You do not have permission to make this change.")
        } else if (result.error.kind === "stale-client") {
          setMessage("This page is out of date. Refresh to update it.")
        } else if (result.error.kind === "delivery-cancelled") {
          setMessage(
            "Confirmation was interrupted. The change may have been saved."
          )
        } else if (result.error.kind !== "root-unmounted") {
          setMessage("The change was not saved.")
        }
      },
      onCanonization(result) {
        if (result.ok) setMessage("Saved and up to date.")
      },
    })
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        rename()
      }}
    >
      <label htmlFor="note-title">Title</label>
      <input
        id="note-title"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
      />
      <button type="submit">Rename</button>
      <p role="status">{message}</p>
    </form>
  )
}
```

Each callback reports its own mutation. If the interface permits overlapping submissions, an earlier mutation can finish while another is pending. Use the root's `status` for an overall saving indicator, or track receipts separately when displaying per-edit messages.

If prediction fails, only `onPrediction` runs: no receipt is created and the later stages do not open. Once a receipt exists, acceptance and canonization callbacks can report terminal failures as well as success. Their error shape is `MutationLifecycleError`; a server's public refusal is under `result.error.error` when `result.error.kind === "domain"`.

To name a mutation's public error type in your own code, such as a save hook that covers several mutations, use `MutationErrorOf` from `headcanon`. It is the union of the mutation's prediction error and its refusal:

```ts
import type { MutationErrorOf } from "headcanon"

type SaveError = MutationErrorOf<typeof renameNote>
```

### Await a receipt for sequential work

Use the receipt promises when an event handler needs to wait for a particular stage:

```ts
// Inside a component that already has mutate and value:
async function renameAndWait(title: string) {
  const prediction = mutate(renameNote({ noteId: value.id, title }))
  if (!prediction.ok) return prediction

  const receipt = prediction.value
  const accepted = await receipt.accepted
  if (!accepted.ok) return accepted

  // The write is committed. Await this only if the view must catch up too.
  return await receipt.canonized
}
```

Both promises resolve with a `Result`; they never reject. Check `ok` instead of using `catch` to detect mutation failure. Uncertain delivery keeps them unsettled until a later outcome or root unmount. Acceptance can succeed while canonization later reports that the root unmounted.

### Set default listeners

Pass `mutationListeners` to `createNextPredictedRoot` for shared defaults. A `mutate` call overrides only the stages it supplies. For example, a call with `onAcceptance` keeps the factory's prediction and canonization listeners but replaces its acceptance listener; the factory's acceptance listener does not run.

If `onPrediction` throws, the exception comes out of `mutate` in your event handler. On a successful prediction, the mutation is already queued before that callback runs; the exception does not undo it. If `onAcceptance` or `onCanonization` throws, it produces an unhandled promise rejection: Headcanon attaches these callbacks with `.then(...)` and does not catch the returned promise. The original receipt promises still resolve with a `Result`. Handle errors inside listeners and in any asynchronous work they start.

## Read delivery and freshness separately

| Field                  | Meaning                                                                                                                      |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `status.pending`       | Number of unsettled mutations, including accepted mutations waiting for covering canon.                                      |
| `status.delivery`      | `"idle"`, `"sending"`, or `"uncertain"`. Describes the queue's progress toward acceptance.                                   |
| `status.freshness`     | `"current"`, `"grace"`, `"refreshing"`, or `"stalled"`. Describes whether canon meets the root's known refresh requirements. |
| `status.stallReason`   | Available only while freshness is `"stalled"`: `"behind"`, `"missing-axis"`, or `"refresh-error"`.                           |
| `status.missingAxes`   | Required axes absent from canon, not axes that are merely behind.                                                            |
| `status.invalidations` | The invalidation transport's status: `"disabled"`, `"active"`, `"reauthorizing"`, `"polling"`, or `"unavailable"`.           |

Delivery can be `"idle"` while `pending` is greater than zero: the server has answered, but the view is still catching up. `"sending"` includes queued work and automatic retry delays. Freshness can be `"current"` while a mutation is still awaiting acceptance because its accepted revisions are not known yet.

`"current"` means the root has met the requirements it knows about, not that no newer write exists anywhere. Without an invalidation adapter, `status.invalidations` is `"disabled"`; this is configuration, not a connection failure. It does not enable automatic polling, and nothing refreshes the root when the viewer returns to the tab. To add that, pass `withVisibilityRefresh(createNoRealtimeInvalidationAdapter())` as `invalidations`; see [Realtime updates](realtime.md#refresh-when-the-viewer-returns).

With the router carrier, `"refreshing"` reports what Headcanon knows. The router gives no failure signal, so a refresh that fails in the browser does not become `"stalled"`: Next.js reloads the page instead.

## Offer the right retry control

Uncertain delivery and stalled freshness require different actions. Render recovery controls once within the shared provider:

```tsx
// app/notes/[id]/note-status.tsx
"use client"

import { NoteRoot } from "@/lib/notes/root"

export function NoteStatus() {
  const { status, retryDelivery, retryRefresh } = NoteRoot.useRoot()

  return (
    <div>
      {status.pending > 0 && (
        <p role="status">Changes awaiting confirmation: {status.pending}</p>
      )}

      {status.delivery === "uncertain" && (
        <div role="alert">
          <p>
            The server may have saved your change, but has not confirmed it.
          </p>
          <button type="button" onClick={retryDelivery}>
            Retry delivery
          </button>
        </div>
      )}

      {status.freshness === "stalled" && (
        <div role="alert">
          <p>This view has not caught up with the required server data.</p>
          <button type="button" onClick={retryRefresh}>
            Refresh data
          </button>
        </div>
      )}
    </div>
  )
}
```

### Uncertain delivery

An ordinary delivery error, a response that exceeds the root's 10-second wait, or exhausted automatic redelivery attempts can make delivery uncertain. Later mutations wait behind the uncertain queue head. Predictions remain visible unless replay against newer canon refuses them.

`retryDelivery()` resends the original envelope with the same mutation ID and a fresh automatic retry budget. It does nothing unless delivery is uncertain. Do not call `mutate` again to retry the same intent: that creates a new mutation ID and can apply the change twice. A late server answer can still settle the original receipt.

The resent envelope also keeps its original `createdAt`. The server refuses a new execution of an envelope older than its maximum delivery age (7 days by default). While the server still has a receipt for the mutation, a retry gets the stored outcome at any age. After the server deletes old receipts, a retry gets `undeliverable` with `error.code` `"delivery-expired"`, even if the first attempt committed and only its response was lost. Before you offer to make the change again, load current data and check whether it is already saved.

The same rule applies to envelopes sent when the root unmounts and to mutations a root restores from its stored queue after a reload; see [Keep the queue across a reload](#keep-the-queue-across-a-reload). A queue you store and send yourself must also keep each envelope's mutation ID and `createdAt` unchanged. See [Limit delivery age](server-setup.md#limit-delivery-age).

The 10-second wait does not cancel a Next.js Server Action. An unanswered action can still hold up later Server Actions and transitions. Bound server work as described in [Server setup](server-setup.md#bound-database-and-network-waits).

### Stalled freshness

`retryRefresh()` requests another refresh with a fresh attempt budget when the root's requirements are unmet. It does not resend the mutation. An accepted write remains accepted even if the view cannot refresh.

Accepted predictions stay applied while waiting for covering canon, unless a replay conflict removes their predicted effect. A missing axis or persistently old revision requires a loader or storage fix; see [Loading data](loading-data.md#diagnose-data-that-stays-behind).

## Use recovery listeners for notices and effects

Use rendered status for inline controls. Use `recoveryListeners` when your application needs a toast, banner service, or other effect on entering a recovery state.

This excerpt belongs inside a component that mounts the direct hook. `showRetryNotice` is an application-owned helper that displays a notice with a retry button and returns a function that dismisses it:

```ts
const root = useNote({
  canon,
  recoveryListeners: {
    onDeliveryUncertain({ retry }) {
      return showRetryNotice("Delivery is uncertain.", retry)
    },
    onFreshnessStalled({ retry, reason, missingAxes }) {
      console.warn("Refresh stalled:", reason, missingAxes)
      return showRetryNotice("This view needs fresh data.", retry)
    },
    onConflict(conflict) {
      console.info("Prediction removed:", conflict.mutationId, conflict.error)
    },
  },
})
```

The same `recoveryListeners` prop is available on `NoteRoot.Provider`. You can also set defaults on the factory. Per-mount listeners replace only the conditions they supply.

The delivery and freshness listeners may return cleanup functions. Cleanup runs when the condition clears or the root unmounts. `onConflict` runs once per recorded mutation ID during the root's mounted lifetime. These listeners do not implement an automatic reconnect policy; your application chooses when to use their retry controls.

## Handle replay conflicts

When canon changes, Headcanon reapplies pending predictions in invocation order. A prediction that previously succeeded can now refuse. For example, an item another user deleted may no longer be available to edit.

The refused prediction is removed from the displayed value and recorded in `conflicts`. What happens next depends on delivery:

| Mutation state                                                               | What a replay refusal does                                                                                          |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Queued or awaiting automatic retry, and no attempt may have written          | Withdraws the mutation and settles its receipt with `"replay-refused"`.                                             |
| Sending, uncertain, or queued again after an attempt with an unknown outcome | Removes the predicted effect but keeps waiting for the server outcome, since the write may already exist.           |
| Accepted but not yet covered                                                 | Removes the predicted effect but keeps waiting for canon to cover the accepted stamp. The acceptance is not undone. |

Use `onConflict` for one-time feedback. `conflicts` retains the latest 50 entries, oldest first, for display or diagnostics; it is not a complete history of replay conflicts. Server refusals (`kind: "domain"`) do not enter this list.

Calls to `mutate` in the same event check against the same rendered value. If two calls only become incompatible when applied in sequence, both immediate checks can succeed and the later prediction can be refused during replay. Define a single mutation when several edits must be validated and committed together.

## Handle terminal failures

Local prediction failures are returned directly by `mutate`. After a receipt exists, failures use these `kind` values:

| Kind                   | Meaning                                                                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"domain"`             | The server returned the mutation's public refusal, available as `error`.                                                                                                              |
| `"denied"`             | The server denied access without exposing a reason.                                                                                                                                   |
| `"undeliverable"`      | The server rejected this delivery: the envelope, its arguments, a reused mutation ID, or a creation time outside the delivery window. `error` contains the executor failure.          |
| `"stale-client"`       | The server does not know the Server Action this page called, because the page's code is older than the deployed build. This delivery wrote nothing, and a retry cannot help.          |
| `"replay-refused"`     | Replay refused a prediction that could still be withdrawn; `error` contains the predictor's refusal.                                                                                  |
| `"delivery-cancelled"` | The Next binding passed framework control flow, such as a redirect, back to Next.js. This does not prove the write was rolled back: `finalizeAccepted` can redirect after the commit. |
| `"root-unmounted"`     | The root stopped observing the mutation. `outcome` is `"accepted"` if acceptance was known, otherwise `"unknown"`.                                                                    |

An `"undeliverable"` delivery wrote nothing, but it does not always prove that the mutation never committed. `error.code` tells you more:

- `"delivery-expired"`: the envelope is older than the server's maximum delivery age. An earlier delivery of it may have committed if its receipt has since been deleted. Check current data before creating a replacement mutation.
- `"delivery-from-future"`: the envelope's `createdAt` is too far ahead of the server's clock, usually because the device clock is wrong. Ask the user to correct the clock. The server could admit the same envelope later, for example from another tab.

`"denied"`, `"undeliverable"`, and `"stale-client"` also carry `mayHaveCommitted`. It is `true` when an earlier delivery of the same mutation may have committed: an attempt threw an ordinary error or got no answer within `DELIVERY_WAIT_MS`, so delivery became uncertain, or the root restored the mutation after a reload (see [Keep the queue across a reload](#keep-the-queue-across-a-reload)). The final answer then describes only the last delivery, and the change may exist on the server. It is `false` when every earlier attempt in this page was answered and none committed.

```ts
onAcceptance(result) {
  if (result.ok || result.error.kind !== "stale-client") return
  showNotice(
    result.error.mayHaveCommitted
      ? "Your change could not be confirmed. Refresh to check it."
      : "Refresh to update."
  )
}
```

Show a "Refresh to update" prompt for `"stale-client"`. Only a page reload loads the new build. Each mutation that is still queued is also sent and also fails with `"stale-client"`, one at a time, so the root does not stop. Next.js can keep an action's ID across builds, so an old page can still save some changes after a deploy. Headcanon reports `"stale-client"` only when the server does not know the action's ID.

Delivery uncertainty is a root status, not a terminal failure. A stalled refresh also leaves canonization pending while the root remains mounted.

## Choose the root's lifetime

Place the root high enough to outlive the components that edit its data. Closing a dialog inside a mounted provider can leave its mutation running and observable. Unmounting the provider ends that observation.

Unmount settles unresolved receipt milestones with `"root-unmounted"`. A receipt whose acceptance already succeeded keeps that accepted result, while its unfinished canonization reports unmount with `outcome: "accepted"`.

Unmount is not cancellation. Without `persistence`, the root starts a best-effort send of remaining unsent envelopes after outstanding delivery attempts settle, whether they succeed or fail. It sends those envelopes sequentially but does not report their results through the settled receipts. It does not resend sending or uncertain envelopes merely because it unmounted. This is not durable delivery across a page reload or a closed tab.

That ordering applies only within the unsent group. While mounted, the queue waits behind an uncertain head; after unmount, later queued mutations can be sent without recovering that head's outcome. If the head never reached the server, a later mutation can commit without the earlier one. If an outstanding request never settles, the unsent group remains waiting. Do not rely on unmount delivery to preserve dependencies across an uncertain mutation.

With `persistence`, the queue outlives its root. After unmount, the root's mutations keep being delivered in order, one at a time, including a mutation queued at unmount, such as an autosave flushed from an unmount cleanup, or by a `mutate` call that runs after unmount, such as a debounced save. Delivery stops at a mutation whose outcome is uncertain, so a later mutation never commits before an earlier one that did not reach the server. A mutation that is still being sent finishes, and its answer still updates storage.

A root of the same factory that later mounts with the same key continues that queue instead of restoring it from storage. It shows every mutation still in the queue, including one accepted after unmount until the new root's canon includes it, and reports their outcomes to the factory's `mutationListeners` with `restored: true`. It delivers an uncertain mutation again, as a reload does. When a root replaces another in one commit, such as after a change of React `key`, the old root's receipts settle with `"root-unmounted"` and the new root continues the queue. See [Keep the queue across a reload](#keep-the-queue-across-a-reload).

Background delivery still calls `send`. With the Next binding, a Server Action that redirects can still navigate the page after the root has unmounted; the root itself passes no control flow to React.

If navigation depends on knowing that a write succeeded, await acceptance before navigating. If it depends on this view receiving the updated data, await canonization while the root is still mounted. Do not infer that a write failed just because its root disappeared.

## Keep the queue across a reload

A root keeps its queue in memory. A page reload, such as the one a failed router refresh causes, drops every mutation the server has not accepted. Pass `persistence` to keep the queue in the tab's `sessionStorage`. Each mounted root needs its own key, so pass a function that picks the key from the root's canon:

```ts
// lib/notes/root.ts
"use client"

import { createNextPredictedRoot } from "headcanon/next/client"
import { sessionStoragePersistence } from "headcanon/react"

import { applyNotesMutation } from "./actions"
import { notesProtocol } from "./protocol"

export const useNote = createNextPredictedRoot({
  protocol: notesProtocol,
  action: applyNotesMutation,
  persistence: (canon) =>
    sessionStoragePersistence(`notes-queue:${canon.value.id}`),
  mutationListeners: {
    onAcceptance(result, mutation) {
      if (mutation.restored && !result.ok) {
        showNotice("A change made before the page reloaded was not saved.")
      }
    },
  },
})
```

`showNotice` is an application-owned helper.

Each root calls the function once, when it mounts, with its first canon. Key the root by the record's identity (see [Share one root across components](#share-one-root-across-components)), so the record's ID does not change while the root is mounted. Return `undefined` to keep a root's queue in memory only. A single `QueuePersistence` object, instead of a function, gives every root of the factory the same key; use it only when the factory mounts one root at a time.

The key also names the queue in memory. While a queue still has mutations to deliver after its root unmounts, a root of the same factory that mounts with the same key continues it. Use each key with one factory only.

The root stores each envelope (mutation ID, protocol, `createdAt`, and invocation) when `mutate` queues it. It removes the envelope when the server accepts the mutation or the mutation fails, also after the root has unmounted. Unmount does not remove an envelope, and a mutation queued from an unmount cleanup, such as an autosave, is stored too. Every write finishes before `mutate` returns, so nothing is lost when the page reloads right after an edit.

When a root mounts, it restores the stored mutations once, ahead of any new mutation, and delivers them again in order under their original mutation IDs. A `mutate` call that comes first, such as one from a child's mount effect, restores the queue itself and is predicted over the restored mutations. This is safe: the server keeps one receipt per mutation ID, so a mutation that already committed gets its stored outcome and is not applied twice. The restored predictions are replayed over the new page's canon, like any pending mutation. A restored mutation may already have been sent by the earlier page, so a replay refusal hides its prediction but does not withdraw it; the root waits for the server's answer.

Restored mutations count in `status.pending` and `status.delivery`. No `mutate` call holds their receipts, so the factory's `mutationListeners` report them. `onAcceptance` and `onCanonization` receive a second argument, `{ id, restored }`; `restored` is `true` for a restored mutation. `onPrediction` does not run for it.

The root checks every stored envelope before it restores it. It drops an envelope for a different protocol ID, an unknown mutation name, an envelope with missing or extra fields (including a missing `createdAt`), arguments that the mutation's schema refuses or changes (the server admits only arguments in parsed form), and a repeated mutation ID. A stored value that is not valid JSON is dropped completely. A schema that validates asynchronously cannot be checked in time, so its mutations are dropped too. Dropped mutations are not reported.

If storage is missing or refuses a read or write, for example in a private window or when it is full, `mutate` still works and the queue stays in memory. A root that cannot read storage never writes to it either, so whatever it holds stays there for a later mount. Text under the key that is not JSON counts as a stored value the root cannot use, and the root replaces it.

If storage still holds a mutation that failed with no receipt on the server (any failure except `"domain"`) because the write that removed it failed, the root sends nothing more until a write removes it. A later page load could restore and commit that mutation, so sending a later one first could reverse their order. The root writes the queue again before each delivery.

Know the limits:

- **Delivery after unmount stops at an uncertain mutation.** The rest of the queue waits in storage until a root with the same key mounts again or the page reloads. See [Choose the root's lifetime](#choose-the-roots-lifetime).
- **One tab.** `sessionStorage` belongs to one tab, and a closed tab loses it, together with any delivery still in progress. A duplicated tab gets a copy, so both tabs deliver the same mutations. This is safe: they share mutation IDs, and the server's receipts make the second delivery return the first one's outcome.
- **One mounted root per key.** Two roots mounted at the same time with the same key are not supported: they render one queue, but only the first holds its receipts, and roots of two factories overwrite each other's stored queue. Give each mounted root its own key, such as one that includes the record's ID.
- **No other devices or browsers.** Nothing leaves the browser until it is delivered.
- **Delivery age.** A restored envelope keeps its original `createdAt`. If it is older than the server's maximum delivery age and the server has no receipt for it, delivery fails with `"undeliverable"` and `error.code` `"delivery-expired"`. See [Limit delivery age](server-setup.md#limit-delivery-age).
- **JSON arguments.** `sessionStoragePersistence` stores envelopes as JSON. Mutation arguments must already be canonical JSON for the server, so this loses nothing.

To use another store, such as `localStorage` or a store in memory, pass any object with a `key` string and synchronous `load()` and `save(envelopes)` methods. A `save` that throws must leave the stored value unchanged. An asynchronous store, such as IndexedDB, is not supported. A store that several tabs share, such as `localStorage`, acts like two roots with one key: each tab overwrites the other's queue.

## Submit an operation

An [operation](server-setup.md#run-an-operation-outside-a-protocol) is a write outside a protocol, such as creating a run. Nothing predicts it: the form waits for the server's answer, which can carry a result. `createNextOperationHook` keeps one envelope per submission, so a retry after a lost response returns the first answer instead of writing twice.

Create the hook once, outside your components:

```ts
// lib/runs/hooks.ts
"use client"

import { createNextOperationHook } from "headcanon/next/client"

import { createRunAction } from "./actions"
import { createRun } from "./operations"

export const useCreateRun = createNextOperationHook({
  operation: createRun,
  action: createRunAction,
})
```

Call it once per form:

```tsx
// components/new-run-form.tsx
"use client"

import { useCreateRun } from "@/lib/runs/hooks"
import { sessionStoragePersistence } from "headcanon/react"
import { useRouter } from "next/navigation"

export function NewRunForm({ playerId }: { playerId: string }) {
  const router = useRouter()
  const createRun = useCreateRun({
    persistence: sessionStoragePersistence(`new-run:${playerId}`),
    onSettled: (answer) => {
      if (answer.ok) router.push(`/runs/${answer.value.runId}`)
    },
  })

  async function submit(formData: FormData) {
    const outcome = await createRun.run({ name: String(formData.get("name")) })
    if (!outcome.ok && outcome.error.kind === "refused") {
      showNotice("You have too many runs.")
    }
  }

  return (
    <form action={submit}>
      <input name="name" defaultValue={createRun.pending?.args.name} />
      <button disabled={createRun.status === "sending"}>Make the run</button>
      {createRun.status === "unconfirmed" && (
        <p>
          Not saved yet.{" "}
          <button type="button" onClick={() => createRun.retry()}>
            Try again
          </button>
          <button type="button" onClick={createRun.discard}>
            Start over
          </button>
        </p>
      )}
    </form>
  )
}
```

`showNotice` is an application-owned helper.

### How the hook keeps one key

The hook holds at most one submission:

| Call                                | What happens                                                                                               |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `run(args)` with nothing held       | Makes a new envelope (mutation ID and `createdAt`), stores it if `persistence` is set, and sends it.       |
| `run(args)` with the same arguments | Retries the held submission. It never makes a second envelope.                                             |
| `run(args)` with other arguments    | Returns `pending-submission` and sends nothing, until `retry()` or `discard()`.                            |
| `retry()`                           | Sends the held envelope again: same mutation ID, arguments, and `createdAt`. Joins a call still in flight. |
| `discard()`                         | Forgets the held submission. A delivery of it may still commit; its answer no longer changes the hook.     |

Exhausted contention on the server resends the same envelope after a short backoff. Any answer from the server ends the submission: the next `run` makes a new envelope.

`discard()` is the one way to make a new envelope while a submission may have committed. Offer it as a deliberate choice, such as "Start over", and expect that the discarded submission may also have been saved.

### Read the status and the answer

`status` is `"idle"`, `"sending"`, `"unconfirmed"`, or `"settled"`. `pending` holds the held submission's `args`, `restored`, and `mayHaveCommitted` while one is held. `outcome` holds the last answer while `settled`.

`run()` and `retry()` resolve with the server's answer, or with `unconfirmed` after `DELIVERY_WAIT_MS` (10 seconds) or a failed call. They do not reject, except to pass on Next.js control flow, such as a `redirect()` from the server. A form Action that awaits `run()` therefore ends within the wait. The submission stays held, and an answer that arrives later still settles it.

Put navigation and other effects of an answer in `onSettled`. It receives each answer once: from `run`, from `retry`, or later than both, also after a page load. An answer that arrives while no hook with the key is mounted is delivered once to the next one that mounts.

| Answer or result              | Meaning                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------- |
| `ok(result)`                  | The operation was accepted. A retry gets the same result.                             |
| `refused`                     | The command refused with a public refusal. A retry gets the same refusal.             |
| `denied`                      | Screening or admission denied the submission.                                         |
| `undeliverable`               | The executor refused this delivery, for example `delivery-expired`. It wrote nothing. |
| `stale-client`                | The page is older than the deployed build. Reload it.                                 |
| `unconfirmed` (not an answer) | No answer yet. The submission is still held: offer `retry()` and `discard()`.         |
| `pending-submission` (local)  | Other arguments while a submission is held. Nothing was sent.                         |
| `no-submission` (local)       | `retry()` with nothing held and no answer. Nothing was sent.                          |

`denied`, `undeliverable`, and `stale-client` carry `mayHaveCommitted`, as in [Handle terminal failures](#handle-terminal-failures).

### Keep the submission across a reload

Without `persistence`, the held submission lives only in memory, and a page reload loses it. A user who reloads and submits again then makes a new envelope, and a submission that committed before the reload can be written twice. Pass `persistence` to keep the held envelope in `sessionStorage`. The hook stores it before the first send and removes it when the server answers or the user discards it.

A restored submission is `unconfirmed`, with `pending.restored` set. The hook never sends it on its own: show the user what was submitted and offer `retry()` and `discard()`. The hook checks a stored value as a root checks its queue, and drops anything that is not one envelope of this operation.

Hooks of one factory with the same key share one submission, also across a remount. Use each key with one factory only, and do not share a key with a predicted root.

## Use an observed root for read-only views

`createNextObservedRoot` uses the same freshness and invalidation handling without a mutation queue:

```tsx
// app/notes/[id]/note-preview.tsx
"use client"

import type { NoteState } from "@/lib/notes/protocol"
import type { Canon } from "headcanon"
import { createNextObservedRoot } from "headcanon/next/client"

const useObservedNote = createNextObservedRoot()

export function NotePreview({ canon }: { canon: Canon<NoteState> }) {
  const { value, status, retryRefresh } = useObservedNote({ canon })

  return (
    <section>
      <h2>{value.title}</h2>
      {status.freshness === "stalled" && (
        <button type="button" onClick={retryRefresh}>
          Refresh data
        </button>
      )}
    </section>
  )
}
```

Its `value` is confirmed canon only. It exposes `status` and `retryRefresh`, but no `mutate`, delivery status, or pending mutation count. Supply `invalidations` to the factory when the view should react to changes from other clients. Without that adapter, this example depends on its parent delivering new canon and does not discover remote writes by itself.

## Use React without the Next binding

`createPredictedRoot` and `createObservedRoot` from `headcanon/react` accept explicit refresh dependencies. A predicted root also needs a `send` function:

| Dependency      | Contract                                                                                                                         |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `send`          | Delivers the envelope and resolves with an accepted stamp or a public refusal. An ordinary throw means the outcome is uncertain. |
| `refresh`       | A React hook returning a `RefreshAdapter`. For snapshot data, call `useSnapshotRefresh(refetch)` inside this hook.               |
| `invalidations` | Optional adapter that notifies the root about newer revisions or subscription gaps.                                              |

Use `RetryableDeliveryError` only when the authority confirms it stored no terminal receipt, and `TerminalDeliveryError` for a known terminal delivery failure. Throw `new TerminalDeliveryError({ kind: "stale-client" }, { cause })` when the server does not know the endpoint this client called. The Next binding already translates generated-action outcomes, and Next's unknown-action error, into these categories.

A snapshot refetch must update the canon passed to the root; returning fetched data alone does not install it. Keep the refetch function stable. Promise-returning refreshes complete when their promise settles, while a void refresh waits for changed canon to arrive. See [Loading data](loading-data.md) for coverage and refresh requirements.

## Further reading

- [Getting started](getting-started.md) — the complete note editor.
- [Loading data](loading-data.md) — canon, cache tags, and refresh diagnosis.
- [Server setup](server-setup.md) — commands, receipts, and bounded server work.
- [Realtime updates](realtime.md) — invalidation adapters and polling fallback.
- [Testing](testing.md) — testing roots and adapters.
