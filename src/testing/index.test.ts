import { execFileSync } from "node:child_process"
import { err, ok } from "serializable-result"
import { describe, expect, it } from "vitest"

import {
  throwMutationContention,
  type MutationAuthorityRequest,
} from "../core/authority"
import { createInMemoryMutationAuthority } from "./index"

type Refusal = { readonly code: "refused" }

function parseRefusal(value: unknown): Refusal {
  if (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    value.code === "refused"
  ) {
    return { code: "refused" }
  }
  throw new Error("Invalid test refusal")
}

function request(sequence: number): MutationAuthorityRequest<string, Refusal> {
  const json = JSON.stringify({ sequence })
  return {
    actor: "actor",
    mutationId: `20000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`,
    protocol: "test.in-memory.v1",
    canonical: {
      json,
      bytes: new TextEncoder().encode(json),
      sha256: `fingerprint-${sequence}`,
    },
    parseRefusal,
  }
}

function counter(options: { readonly maxAttempts?: number } = {}) {
  return createInMemoryMutationAuthority<number, string, Refusal>({
    initialState: 0,
    scope: (actor) => actor,
    ...options,
  })
}

describe("in-memory mutation authority", () => {
  it("reruns a command that throws contention, as production adapters do", async () => {
    const authority = counter()
    let attempts = 0

    const outcome = await authority.execute(request(1), async (tx) => {
      attempts += 1
      tx.write(tx.read() + 1)
      if (attempts === 1) throwMutationContention()
      return ok(undefined)
    })

    expect(outcome).toMatchObject({ ok: true, value: { kind: "accepted" } })
    expect(attempts).toBe(2)
    expect(authority.read()).toBe(1)
  })

  it("returns contention without a receipt when every attempt throws contention", async () => {
    const authority = counter({ maxAttempts: 3 })
    let attempts = 0

    const outcome = await authority.execute(request(2), async (tx) => {
      attempts += 1
      tx.write(tx.read() + 1)
      return throwMutationContention()
    })

    expect(outcome).toEqual(
      err({ code: "contention", mutationId: request(2).mutationId })
    )
    expect(attempts).toBe(3)
    expect(authority.read()).toBe(0)
    expect(authority.hasReceipt("actor", request(2).mutationId)).toBe(false)
  })

  it("consumes queued contention in the next attempt even when it refuses", async () => {
    const authority = counter()
    authority.contendNext((current) => current + 10)

    const refused = await authority.execute(request(3), async () =>
      err({ kind: "refused", error: { code: "refused" } })
    )
    let attempts = 0
    const accepted = await authority.execute(request(4), async (tx) => {
      attempts += 1
      tx.write(tx.read() + 1)
      return ok(undefined)
    })

    expect(attempts).toBe(1)
    expect(authority.read()).toBe(11)
    expect(refused).toEqual(ok({ kind: "refused", error: { code: "refused" } }))
    expect(accepted).toMatchObject({ ok: true, value: { kind: "accepted" } })
  })

  it("lets different mutation IDs interleave while one ID runs at a time", async () => {
    const authority = counter()
    const events: string[] = []
    let releaseFirst: () => void = () => undefined
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const first = authority.execute(request(5), async () => {
      events.push("first:start")
      await firstMayFinish
      events.push("first:end")
      return ok(undefined)
    })
    const duplicate = authority.execute(request(5), async () => {
      events.push("duplicate")
      return ok(undefined)
    })
    const other = authority.execute(request(6), async () => {
      events.push("other")
      return ok(undefined)
    })
    await other

    expect(events).toEqual(["first:start", "other"])
    releaseFirst()
    expect(await duplicate).toEqual(await first)
    expect(events).toEqual(["first:start", "other", "first:end"])
  })

  it("reruns an attempt that another mutation's commit overtook", async () => {
    const authority = counter()
    let releaseSlow: () => void = () => undefined
    const slowMayWrite = new Promise<void>((resolve) => {
      releaseSlow = resolve
    })
    let slowAttempts = 0

    const slow = authority.execute(request(7), async (tx) => {
      slowAttempts += 1
      const current = tx.read()
      if (slowAttempts === 1) await slowMayWrite
      tx.write(current + 1)
      return ok(undefined)
    })
    await authority.execute(request(8), async (tx) => {
      tx.write(tx.read() + 10)
      return ok(undefined)
    })
    releaseSlow()

    expect(await slow).toMatchObject({ ok: true })
    expect(slowAttempts).toBe(2)
    expect(authority.read()).toBe(11)
  })

  it("passes its committed-state reader to screening as preflight", async () => {
    const authority = counter()
    let screenedMidAttempt: number | undefined

    await authority.execute(request(9), async (tx) => {
      tx.write(5)
      screenedMidAttempt = authority.preflight.read()
      return ok(undefined)
    })

    expect(screenedMidAttempt).toBe(0)
    expect(authority.preflight.read()).toBe(5)
  })
})

describe("headcanon/testing entry", () => {
  it("imports in plain Node without vitest or Testing Library", () => {
    // Resolves the extensionless source imports and refuses any test
    // framework, so a stray import fails here rather than in an adopter's
    // Jest run or Next server module.
    const hook = `
      export async function resolve(specifier, context, next) {
        if (specifier === "vitest" || specifier.startsWith("vitest/") ||
            specifier.startsWith("@testing-library/")) {
          throw new Error("headcanon/testing imported " + specifier)
        }
        if (specifier.startsWith(".") && !/\\.[cm]?[jt]sx?$/.test(specifier)) {
          return next(specifier + ".ts", context)
        }
        return next(specifier, context)
      }`
    const script = `
      import { register } from "node:module"
      register("data:text/javascript," + encodeURIComponent(${JSON.stringify(hook)}))
      const testing = await import(${JSON.stringify(new URL("./index.ts", import.meta.url).href)})
      const authority = testing.createInMemoryMutationAuthority({
        initialState: 0,
        scope: (actor) => actor,
      })
      const invalidations = testing.createInMemoryInvalidationAdapter()
      console.log(JSON.stringify([authority.read(), invalidations.published]))`

    const output = execFileSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings",
        "--input-type=module",
        "--eval",
        script,
      ],
      { encoding: "utf8" }
    )

    expect(output.trim()).toBe("[0,[]]")
  })
})
