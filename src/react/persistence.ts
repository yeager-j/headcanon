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
 * `mutate` returns. Either method may throw: the root then keeps its queue in
 * memory only.
 *
 * The root checks every loaded envelope and drops any it cannot deliver, so
 * the store needs no validation of its own.
 */
export interface QueuePersistence {
  /** Returns the stored queue, or `undefined` when nothing is stored. */
  load(): unknown
  /**
   * Replaces the stored queue with `envelopes`, in mutation order. An empty
   * list means no mutation is pending.
   */
  save(envelopes: readonly MutationEnvelope<unknown>[]): void
}

/**
 * Stores a predicted root's pending envelopes in `sessionStorage` under `key`,
 * as JSON. The key is removed when no mutation is pending.
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
      return stored === null ? undefined : (JSON.parse(stored) as unknown)
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
}

/** Storage for a root without `persistence`: the queue lives in memory. */
const MEMORY_QUEUE_STORAGE: QueueStorage<never> = {
  load: () => [],
  save: () => undefined,
}

/**
 * Wraps `persistence` so that no storage failure reaches the ledger. A failed
 * write leaves the last stored queue; the next change writes again.
 */
export function createQueueStorage<Invocation>(
  persistence: QueuePersistence | undefined,
  protocol: AnyProtocolDefinition
): QueueStorage<Invocation> {
  if (!persistence) return MEMORY_QUEUE_STORAGE

  return {
    load() {
      let stored: unknown
      try {
        stored = persistence.load()
      } catch {
        return []
      }

      return parseStoredQueue<Invocation>(stored, protocol)
    },
    save(envelopes) {
      try {
        persistence.save(envelopes)
      } catch {
        // Storage is best effort; the queue in memory is still complete.
      }
    },
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
  let validation: ReturnType<StandardSchemaV1["~standard"]["validate"]>
  try {
    validation = schema["~standard"].validate(args)
  } catch {
    return false
  }

  if (validation instanceof Promise) {
    validation.catch(() => undefined)
    return false
  }

  if (validation.issues !== undefined) return false

  return isParsedForm(args, validation.value)
}
