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

The Next binding supplies Server Action delivery and router refresh. A router refresh that fails reloads the whole page, which drops the root's queue and any unsaved drafts; see [Loading data](loading-data.md#a-failed-router-refresh-reloads-the-page). The binding also passes Next.js navigation signals, such as redirects, back to the framework instead of treating them as uncertain delivery.

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

The same rule applies to envelopes sent when the root unmounts and to any queue that stores envelopes and sends them later, such as one kept in `sessionStorage`. Such a queue must keep each envelope's mutation ID and `createdAt` unchanged. See [Limit delivery age](server-setup.md#limit-delivery-age).

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
| `"stale-client"`       | The server does not know the Server Action this page called, because the page's code is older than the deployed build. The write was never made, and a retry cannot help.             |
| `"replay-refused"`     | Replay refused a prediction that could still be withdrawn; `error` contains the predictor's refusal.                                                                                  |
| `"delivery-cancelled"` | The Next binding passed framework control flow, such as a redirect, back to Next.js. This does not prove the write was rolled back: `finalizeAccepted` can redirect after the commit. |
| `"root-unmounted"`     | The root stopped observing the mutation. `outcome` is `"accepted"` if acceptance was known, otherwise `"unknown"`.                                                                    |

An `"undeliverable"` delivery wrote nothing, but it does not always prove that the mutation never committed. `error.code` tells you more:

- `"delivery-expired"`: the envelope is older than the server's maximum delivery age. An earlier delivery of it may have committed if its receipt has since been deleted. Check current data before creating a replacement mutation.
- `"delivery-from-future"`: the envelope's `createdAt` is too far ahead of the server's clock, usually because the device clock is wrong. Ask the user to correct the clock. The server could admit the same envelope later, for example from another tab.

Show a "Refresh to update" prompt for `"stale-client"`. Only a page reload loads the new build. Each mutation that is still queued is also sent and also fails with `"stale-client"`, one at a time, so the root does not stop. Next.js can keep an action's ID across builds, so an old page can still save some changes after a deploy. Headcanon reports `"stale-client"` only when the server does not know the action's ID.

Delivery uncertainty is a root status, not a terminal failure. A stalled refresh also leaves canonization pending while the root remains mounted.

## Choose the root's lifetime

Place the root high enough to outlive the components that edit its data. Closing a dialog inside a mounted provider can leave its mutation running and observable. Unmounting the provider ends that observation.

Unmount settles unresolved receipt milestones with `"root-unmounted"`. A receipt whose acceptance already succeeded keeps that accepted result, while its unfinished canonization reports unmount with `outcome: "accepted"`.

Unmount is not cancellation. The root starts a best-effort send of remaining unsent envelopes after outstanding delivery attempts settle, whether they succeed or fail. It sends those envelopes sequentially but does not report their results through the settled receipts. It does not resend sending or uncertain envelopes merely because it unmounted. This is not durable delivery across a closed tab or page reload.

That ordering applies only within the unsent group. While mounted, the queue waits behind an uncertain head; after unmount, later queued mutations can be sent without recovering that head's outcome. If the head never reached the server, a later mutation can commit without the earlier one. If an outstanding request never settles, the unsent group remains waiting. Do not rely on unmount delivery to preserve dependencies across an uncertain mutation.

If navigation depends on knowing that a write succeeded, await acceptance before navigating. If it depends on this view receiving the updated data, await canonization while the root is still mounted. Do not infer that a write failed just because its root disappeared.

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
- [Realtime updates](realtime.md) — planned guide to invalidation adapters and polling fallback.
- [Testing](testing.md) — planned guide to testing roots and adapters.
