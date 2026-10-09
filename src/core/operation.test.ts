import type { StandardSchemaV1 } from "@standard-schema/spec"
import { err, ok } from "serializable-result"
import { describe, expect, expectTypeOf, it } from "vitest"

import {
  createOperationEnvelope,
  defineOperation,
  defineProtocol,
  type OperationArgsOf,
  type OperationRefusalOf,
  type OperationResultOf,
} from ".."
import { prepareMutationRequest } from "./authority"
import { operationRegistry } from "./operation"
import { OPERATION_PROTOCOL_ID } from "./protocol"

type NameArgs = { readonly name: string }
type RunResult = { readonly runId: string }

function schema<Output>(
  accepts: (value: unknown) => value is Output
): StandardSchemaV1<unknown, Output> {
  return {
    "~standard": {
      version: 1,
      vendor: "headcanon-test",
      validate: (value) =>
        accepts(value)
          ? { value }
          : { issues: [{ message: "Rejected by the test schema" }] },
    },
  }
}

const nameArgs = schema(
  (value): value is NameArgs =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as { name?: unknown }).name === "string"
)

const runResult = schema(
  (value): value is RunResult =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as { runId?: unknown }).runId === "string"
)

const tooMany = schema((value): value is "too-many" => value === "too-many")

const createRun = defineOperation({
  name: "run.create.v1",
  args: nameArgs,
  result: runResult,
  refusal: tooMany,
})

const archiveRun = defineOperation({ name: "run.archive.v1", args: nameArgs })

const MUTATION_ID = "00000000-0000-4000-8000-000000000001"

describe("defineOperation", () => {
  it("types arguments, result, and refusal from its schemas", () => {
    expectTypeOf<OperationArgsOf<typeof createRun>>().toEqualTypeOf<NameArgs>()
    expectTypeOf<
      OperationResultOf<typeof createRun>
    >().toEqualTypeOf<RunResult>()
    expectTypeOf<
      OperationRefusalOf<typeof createRun>
    >().toEqualTypeOf<"too-many">()
  })

  it("gives an operation without a result or refusals schemas that fail closed", () => {
    expectTypeOf<
      OperationResultOf<typeof archiveRun>
    >().toEqualTypeOf<undefined>()
    expectTypeOf<OperationRefusalOf<typeof archiveRun>>().toBeNever()

    const validateResult = archiveRun.result["~standard"].validate
    expect(validateResult(undefined)).toEqual({ value: undefined })
    expect(validateResult(null)).toHaveProperty("issues")
    expect(validateResult({ runId: "r" })).toHaveProperty("issues")
    expect(archiveRun.refusal["~standard"].validate("any")).toHaveProperty(
      "issues"
    )
  })

  it("requires a result schema whose output is a valid input", () => {
    const parsesNumberFromText: StandardSchemaV1<string, number> = {
      "~standard": {
        version: 1,
        vendor: "headcanon-test",
        validate: (value) => ({ value: Number(value) }),
      },
    }

    defineOperation({
      name: "run.count.v1",
      args: nameArgs,
      // @ts-expect-error — the receipt parses the command's number as text.
      result: parsesNumberFromText,
    })
  })

  it("returns a frozen definition and rejects an empty name", () => {
    expect(Object.isFrozen(createRun)).toBe(true)
    expect(() => defineOperation({ name: "", args: nameArgs })).toThrow(
      "An operation needs a name"
    )
  })
})

describe("createOperationEnvelope", () => {
  it("builds a frozen envelope under the reserved operation ID", () => {
    const args = { name: "Emerald" }
    const envelope = createOperationEnvelope(createRun, args, {
      mutationId: MUTATION_ID,
      createdAt: 1_000,
    })
    args.name = "changed"

    expect(envelope).toEqual({
      protocol: OPERATION_PROTOCOL_ID,
      mutationId: MUTATION_ID,
      createdAt: 1_000,
      invocation: { name: "run.create.v1", args: { name: "Emerald" } },
    })
    expect(Object.isFrozen(envelope)).toBe(true)
    expect(Object.isFrozen(envelope.invocation)).toBe(true)
    expect(Object.isFrozen(envelope.invocation.args)).toBe(true)
  })

  it("freezes nested arguments, so a retry cannot send other ones", () => {
    const tagged = defineOperation({
      name: "run.tag.v1",
      args: schema((value): value is { readonly tags: string[] } =>
        Array.isArray((value as { tags?: unknown } | null)?.tags)
      ),
    })
    const envelope = createOperationEnvelope(tagged, { tags: ["a"] })

    expect(() => envelope.invocation.args.tags.push("b")).toThrow(TypeError)
    expect(envelope.invocation.args.tags).toEqual(["a"])
  })

  it("mints a fresh mutation ID and the current time by default", () => {
    const before = Date.now()
    const first = createOperationEnvelope(createRun, { name: "a" })
    const second = createOperationEnvelope(createRun, { name: "a" })

    expect(first.mutationId).not.toBe(second.mutationId)
    expect(first.createdAt).toBeGreaterThanOrEqual(before)
    expect(first.createdAt).toBeLessThanOrEqual(Date.now())
  })
})

describe("operation admission", () => {
  it("admits the operation's own envelope with its canonical identity", async () => {
    const envelope = createOperationEnvelope(
      createRun,
      { name: "Emerald" },
      { mutationId: MUTATION_ID, createdAt: 1_000 }
    )

    const prepared = await prepareMutationRequest(
      operationRegistry(createRun),
      envelope
    )

    expect(prepared).toMatchObject(
      ok({
        mutationId: MUTATION_ID,
        createdAt: 1_000,
        protocol: OPERATION_PROTOCOL_ID,
        mutation: "run.create.v1",
        args: { name: "Emerald" },
      })
    )
  })

  it("refuses another operation's envelope and invalid arguments", async () => {
    const registry = operationRegistry(createRun)
    const other = createOperationEnvelope(archiveRun, { name: "Emerald" })

    expect(await prepareMutationRequest(registry, other)).toEqual(
      err({ code: "invalid-envelope", reason: "unknown-mutation" })
    )
    expect(
      await prepareMutationRequest(registry, {
        ...other,
        invocation: { name: "run.create.v1", args: { name: 1 } },
      })
    ).toMatchObject(
      err({ code: "invalid-arguments", mutation: "run.create.v1" })
    )
  })

  it("reserves the operation ID from protocols", () => {
    expect(() =>
      defineProtocol({ id: OPERATION_PROTOCOL_ID, mutations: [] })
    ).toThrow("Reserved protocol ID: headcanon:operation")
  })
})
