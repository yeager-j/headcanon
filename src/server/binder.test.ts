import type { StandardSchemaV1 } from "@standard-schema/spec"
import { ok } from "serializable-result"
import { describe, expect, expectTypeOf, it } from "vitest"

import {
  acceptMutation,
  allowAdmission,
  allowScreening,
  createMutationBinder,
  refuseMutation,
  type MutationCommandDecision,
} from "."
import {
  defineMutation,
  defineProtocol,
  type MutationErrorOf,
  type MutationRefusalOf,
} from "../core/protocol"
import { axisId } from "../core/revisions"
import {
  createInMemoryMutationAuthority,
} from "../testing"
import {
  assertValidBindings,
  type AnyMutationBinding,
  type CompleteBindings,
} from "./binder"

type NoteState = {
  id: string
  title: string
}

/** Stands in for the README's `z.object({ title: z.string().min(1) })`. */
const titleSchema: StandardSchemaV1<unknown, { title: string }> = {
  "~standard": {
    version: 1,
    vendor: "headcanon-binder-test",
    validate: (value) => ({ value: value as { title: string } }),
  },
}

// The README quick-start mutation: it declares no refusal cases.
const renameNote = defineMutation({
  name: "notes.rename",
  args: titleSchema,
  predict: (state: NoteState, args) => ok({ ...state, title: args.title }),
})

type RenameDecision = MutationCommandDecision<
  MutationRefusalOf<typeof renameNote>
>

const notesProtocol = defineProtocol({
  id: "notes.v1",
  mutations: [renameNote],
})

const noteAxis = axisId("notes/note-1")

function notesBinder() {
  return createMutationBinder({
    actor: () => "actor",
    authority: createInMemoryMutationAuthority<NoteState, string, never>({
      initialState: { id: "note-1", title: "Chapter One" },
      scope: (actor) => actor,
    }),
  })
}

describe("binding a mutation that declares no refusal cases", () => {
  it("binds the README quick-start mutation to a command", () => {
    const binder = notesBinder()

    const binding = binder.bind(renameNote, {
      screen: () => allowScreening(),
      admit: ({ tx }) => allowAdmission(tx.read()),
      execute: ({ tx, args, stamp }) => {
        tx.write({ ...tx.read(), title: args.title })
        stamp.record(noteAxis, 1)
        return acceptMutation()
      },
    })

    expect(binding.mutation).toBe(renameNote)
    expect(notesProtocol.mutations).toEqual([renameNote])
  })

  it("types the refusal as never, so a command cannot refuse", () => {
    const binder = notesBinder()

    expectTypeOf<MutationRefusalOf<typeof renameNote>>().toBeNever()
    expectTypeOf<MutationErrorOf<typeof renameNote>>().toBeNever()

    binder.bind(renameNote, {
      screen: () => allowScreening(),
      admit: () => allowAdmission(),
      execute: ({ args }): RenameDecision => {
        if (args.title !== "") return acceptMutation({ unchanged: true })
        // @ts-expect-error — the mutation declares no refusal cases.
        return refuseMutation("invalid-title")
      },
    })
  })
})

describe("naming the mutations an incomplete binding list gets wrong", () => {
  const archiveNote = defineMutation({
    name: "notes.archive",
    args: titleSchema,
    predict: (state: NoteState) => ok(state),
  })
  const pinNote = defineMutation({
    name: "notes.pin",
    args: titleSchema,
    predict: (state: NoteState) => ok(state),
  })
  const noteProtocol = defineProtocol({
    id: "notes.full.v1",
    mutations: [renameNote, archiveNote, pinNote],
  })

  const binder = notesBinder()
  const command = {
    screen: () => allowScreening(),
    admit: () => allowAdmission(),
    execute: () => acceptMutation({ unchanged: true }),
  }
  const renameBinding = binder.bind(renameNote, command)
  const archiveBinding = binder.bind(archiveNote, command)
  const pinBinding = binder.bind(pinNote, command)

  type NotesBindings<
    Protocol,
    Commands extends readonly AnyMutationBinding[],
  > = CompleteBindings<Protocol, Commands>

  it("names each unbound mutation", () => {
    expectTypeOf<
      NotesBindings<typeof noteProtocol, readonly [typeof renameBinding]>
    >().toEqualTypeOf<{
      readonly __missingMutationBinding: "notes.archive" | "notes.pin"
    }>()
    expect(() =>
      assertValidBindings(noteProtocol, binder, [renameBinding])
    ).toThrow("missing [notes.archive, notes.pin]")
  })

  it("names each mutation the protocol does not have", () => {
    expectTypeOf<
      NotesBindings<
        typeof notesProtocol,
        readonly [
          typeof renameBinding,
          typeof archiveBinding,
          typeof pinBinding,
        ]
      >
    >().toEqualTypeOf<{
      readonly __unknownMutationBinding: "notes.archive" | "notes.pin"
    }>()
    expect(() =>
      assertValidBindings(notesProtocol, binder, [
        renameBinding,
        archiveBinding,
        pinBinding,
      ])
    ).toThrow("does not use the protocol definition: notes.archive")
  })
})
