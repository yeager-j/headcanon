"use client"

import { createContext, createElement, useContext, type ReactNode } from "react"

import type { AnyProtocolDefinition } from "../core/protocol"
import type { PredictedRootHook, ProtocolPredictedRoot } from "./predicted-root"

/** Human-readable identity used in generated provider names and missing-provider errors. */
export interface PredictedRootContextOptions {
  /** Display name for React tools; also names the Provider and the missing-provider error. */
  readonly name: string
}

/** Props accepted by a generated predicted-root provider. */
export type PredictedRootProviderProps<Protocol extends AnyProtocolDefinition> =
  Parameters<PredictedRootHook<Protocol>>[0] & {
    readonly children: ReactNode
  }

/** One mounted predicted-root provider and its context-bound consumer hook. */
export interface PredictedRootContext<Protocol extends AnyProtocolDefinition> {
  /** Mounts one predicted root over `canon` for its subtree. */
  readonly Provider: (props: PredictedRootProviderProps<Protocol>) => ReactNode
  /** Returns the nearest Provider's root. Throws outside a Provider. */
  readonly useRoot: () => ProtocolPredictedRoot<Protocol>
}

/**
 * Creates one context-owned predicted-root lifetime for a React subtree.
 * Calling a predicted-root hook more than once creates independent queues and
 * receipt ledgers; this provider mounts it once and every `useRoot` consumer
 * receives that exact root. Key the provider when one component instance can
 * switch between logical aggregates.
 *
 * @param usePredictedRoot Protocol-specialized root hook to mount once.
 * @param options Human-readable context identity for React tools and errors.
 * @returns A provider that accepts the latest canon and a context-bound root hook.
 * @example
 * ```tsx
 * const useNotes = createPredictedRoot({
 *   protocol: notesProtocol,
 *   send: sendNotesMutation,
 *   refresh: useNotesRefresh,
 * })
 * const NoteRoot = createPredictedRootContext(useNotes, { name: "NoteRoot" })
 *
 * function NoteSurface({ canon }: { canon: Canon<NotesState> }) {
 *   return (
 *     <NoteRoot.Provider canon={canon}>
 *       <RenameButton />
 *     </NoteRoot.Provider>
 *   )
 * }
 *
 * function RenameButton() {
 *   const { value, mutate } = NoteRoot.useRoot()
 *   const rename = () =>
 *     mutate(renameNote({ noteId: value.focused, title: "Chapter Two" }))
 *   return <button onClick={rename}>Rename</button>
 * }
 * ```
 */
export function createPredictedRootContext<
  const Protocol extends AnyProtocolDefinition,
>(
  usePredictedRoot: PredictedRootHook<Protocol>,
  options: PredictedRootContextOptions
): PredictedRootContext<Protocol> {
  type Root = ProtocolPredictedRoot<Protocol>

  const missingRoot = Symbol(options.name)
  const Context = createContext<Root | typeof missingRoot>(missingRoot)
  Context.displayName = options.name

  function Provider({
    children,
    ...input
  }: PredictedRootProviderProps<Protocol>): ReactNode {
    const root = usePredictedRoot(input)
    return createElement(Context.Provider, { value: root }, children)
  }
  Provider.displayName = `${options.name}.Provider`

  function useRoot(): Root {
    const root = useContext(Context)
    if (root === missingRoot) {
      throw new Error(
        `${options.name}.useRoot must be used within ${options.name}.Provider`
      )
    }
    return root
  }

  return Object.freeze({ Provider, useRoot })
}
