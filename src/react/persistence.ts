"use client"

// Queue persistence for a predicted root: the public adapter, the Web Storage
// adapter, and the guarded shell the ledger writes through.
import type { StandardSchemaV1 } from "@standard-schema/spec"

import {
  isParsedForm,
  parseEnvelope,
  type MutationEnvelope,
} from "../core/authority"
import type { AnyProtocolDefinition } from "../core/protocol"

/**
 * A synchronous store for a predicted root's pending envelopes. The root reads
 * it once per mount and writes the whole queue after each change, before
 * `mutate` returns. Either method may throw; the root's queue in memory stays
 * complete.
 *
 * The root checks every loaded value and drops any envelope it cannot
 * deliver, so the store needs no validation of its own.
 */
export interface QueuePersistence {
  /**
   * Returns the stored queue, or `undefined` when nothing is stored. Throw
   * only when the store cannot be read: that root then never writes to the
   * store, so a later mount can still restore what it holds. Return a value
   * the root cannot use, rather than throwing, to have the root replace it.
   */
  load(): unknown
  /**
   * Replaces the stored queue with `envelopes`, in mutation order. An empty
   * list means no mutation is pending. When it throws, it must leave the
   * stored queue unchanged: the root relies on that to know which mutations
   * a later mount restores. The root writes again on the next change.
   */
  save(envelopes: readonly MutationEnvelope<unknown>[]): void
}

/**
 * Stores a predicted root's pending envelopes in `sessionStorage` under `key`,
 * as JSON. The key is removed when no mutation is pending. Text under the key
 * that is not JSON is replaced.
 *
 * `sessionStorage` belongs to one tab: a reload of the tab keeps the queue, a
 * closed tab loses it. Give each mounted root its own key.
 * @param key The `sessionStorage` key. Include the record's identity when one
 *   factory mounts a root per record.
 * @returns A persistence adapter for the `persistence` root option.
 * @example
 * ```ts
 * export const useNote = createNextPredictedRoot({
 *   protocol: notesProtocol,
 *   action: applyNotesMutation,
 *   persistence: (canon) =>
 *     sessionStoragePersistence(`notes-queue:${canon.value.id}`),
 * })
 * ```
 */
export function sessionStoragePersistence(key: string): QueuePersistence {
  return {
    load() {
      const stored = globalThis.sessionStorage.getItem(key)
      if (stored === null) return undefined

      try {
        return JSON.parse(stored) as unknown
      } catch {
        // The read worked; the text is a value the root drops and replaces.
        return stored
      }
    },
    save(envelopes) {
      if (envelopes.length === 0) {
        globalThis.sessionStorage.removeItem(key)
      } else {
        globalThis.sessionStorage.setItem(key, JSON.stringify(envelopes))
      }
    },
  }
}

/** The ledger's view of persistence: it never throws. */
export interface QueueStorage<Invocation> {
  /** The stored envelopes the root can deliver, in mutation order. */
  load(): readonly MutationEnvelope<Invocation>[]
  save(envelopes: readonly MutationEnvelope<Invocation>[]): void
  /**
   * The mutation IDs a later mount would restore: those of the queue last
   * loaded or saved, less the envelopes a load would drop. Empty for a queue
   * that lives only in memory.
   */
  restorableIds(): ReadonlySet<string>
}

const NO_IDS: ReadonlySet<string> = new Set()

/** Storage for a root without `persistence`: the queue lives in memory. */
const MEMORY_QUEUE_STORAGE: QueueStorage<never> = {
  load: () => [],
  save: () => undefined,
  restorableIds: () => NO_IDS,
}

/**
 * Wraps `persistence` so that no storage failure reaches the ledger. A failed
 * write leaves the last stored queue; the next change writes again. After a
 * failed read the root never writes: its queue would replace a stored queue
 * it could not see.
 */
export function createQueueStorage<Invocation>(
  persistence: QueuePersistence | undefined,
  protocol: AnyProtocolDefinition
): QueueStorage<Invocation> {
  if (!persistence) return MEMORY_QUEUE_STORAGE

  let readFailed = false
  let restorable = NO_IDS

  return {
    load() {
      let stored: unknown
      try {
        stored = persistence.load()
      } catch {
        readFailed = true
        return []
      }

      const envelopes = parseStoredQueue<Invocation>(stored, protocol)
      restorable = new Set(envelopes.map((envelope) => envelope.mutationId))
      return envelopes
    },
    save(envelopes) {
      if (readFailed) return

      try {
        persistence.save(envelopes)
      } catch {
        // Storage is best effort; the queue in memory is still complete.
        return
      }
      const kept = parseStoredQueue(envelopes, protocol)
      restorable = new Set(kept.map((envelope) => envelope.mutationId))
    },
    restorableIds: () => restorable,
  }
}

/**
 * The envelopes in `stored` that `protocol` can predict and deliver, in their
 * stored order. Drops a value that is not a list, and each element that is not
 * an exact envelope for `protocol`, whose arguments its mutation's schema does
 * not accept synchronously, or whose mutation ID repeats.
 */
function parseStoredQueue<Invocation>(
  stored: unknown,
  protocol: AnyProtocolDefinition
): MutationEnvelope<Invocation>[] {
  if (!Array.isArray(stored)) return []

  const envelopes: MutationEnvelope<Invocation>[] = []
  const mutationIds = new Set<string>()

  for (const candidate of stored) {
    const parsed = parseEnvelope(candidate, protocol)
    if (!parsed.ok) continue

    const { mutationId, createdAt, definition, args } = parsed.value
    if (mutationIds.has(mutationId)) continue
    if (!hasValidArguments(definition.args, args)) continue

    mutationIds.add(mutationId)
    envelopes.push(
      Object.freeze({
        protocol: protocol.id,
        mutationId,
        createdAt,
        invocation: Object.freeze({
          name: definition.name,
          args,
        }) as Invocation,
      })
    )
  }

  return envelopes
}

/**
 * The predictor runs on restored arguments before the authority sees them,
 * so they must pass the schema now, in the parsed form the authority admits:
 * a schema that coerces or fills in a value would give the predictor
 * arguments its schema never produced. An asynchronous schema cannot answer
 * in time and counts as a refusal.
 */
function hasValidArguments(schema: StandardSchemaV1, args: unknown): boolean {
  // A schema or the canonical check can throw on stored data, for example
  // on nesting deep enough to exhaust the stack. That drops the entry.
  try {
    const validation = schema["~standard"].validate(args)
    if (validation instanceof Promise) {
      validation.catch(() => undefined)
      return false
    }

    if (validation.issues !== undefined) return false

    return isParsedForm(args, validation.value)
  } catch {
    return false
  }
}
