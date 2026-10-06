import type { Rest } from "ably"
import { describe, expect, it, vi } from "vitest"

import { acceptedStamp, axisId, type AcceptedStamp } from "../core/revisions"
import {
  ABLY_AXIS_INVALIDATION_EVENT,
  ablyAxisChannelName,
  ablyChannelNamespace,
} from "./channels"
import {
  AblyInvalidationPublicationError,
  createAblyInvalidationPublisher,
  type AblyBatchPublishSpec,
  type AblyRestClient,
} from "./server"

const axisA = axisId("entity/a")
const axisB = axisId("entity/b")
const namespace = ablyChannelNamespace("preview")

function stamp(revisions: Record<string, number>): AcceptedStamp {
  const parsed = acceptedStamp({ revisions })
  if (!parsed.ok) throw new Error("Invalid Ably publisher test stamp")
  return parsed.value
}

/** Accepts every channel except those listed in `failing`. */
function restClient(failing: ReadonlySet<string> = new Set()) {
  const batchPublish = vi.fn(async (specs: AblyBatchPublishSpec[]) =>
    specs.map(({ channels }) => ({
      results: channels.map((channel) =>
        failing.has(channel)
          ? { channel, error: { code: 40160, message: "denied" } }
          : { channel, messageId: "message", serials: ["serial"] }
      ),
    }))
  )
  return { batchPublish } satisfies AblyRestClient
}

describe("Ably invalidation publisher", () => {
  it("accepts the official Ably v2 REST client", () => {
    const restCompatible: Rest extends AblyRestClient ? true : false = true

    expect(restCompatible).toBe(true)
  })

  it("rejects an invalid namespace at construction", () => {
    expect(() =>
      createAblyInvalidationPublisher({
        rest: restClient(),
        namespace: "preview:",
      })
    ).toThrow("Invalid Ably axis-channel namespace")
  })

  it("batch-publishes one named singleton event per stamped axis", async () => {
    const rest = restClient()
    const publisher = createAblyInvalidationPublisher({
      rest,
      namespace: "preview",
    })

    await publisher.publish("shared-event", stamp({ [axisA]: 2, [axisB]: 4 }))

    expect(rest.batchPublish).toHaveBeenCalledExactlyOnceWith([
      {
        channels: [await ablyAxisChannelName(namespace, axisA)],
        messages: [
          {
            name: ABLY_AXIS_INVALIDATION_EVENT,
            data: { eventId: "shared-event", axis: axisA, revision: 2 },
          },
        ],
      },
      {
        channels: [await ablyAxisChannelName(namespace, axisB)],
        messages: [
          {
            name: "headcanon.axis-invalidation.v1",
            data: { eventId: "shared-event", axis: axisB, revision: 4 },
          },
        ],
      },
    ])
  })

  it("splits more than 100 axes across requests", async () => {
    const rest = restClient()
    const publisher = createAblyInvalidationPublisher({
      rest,
      namespace: "preview",
    })
    const revisions = Object.fromEntries(
      Array.from({ length: 128 }, (_, index) => [`axis/${index}`, index])
    )

    await publisher.publish("wide-event", stamp(revisions))

    expect(rest.batchPublish.mock.calls.map(([specs]) => specs.length)).toEqual(
      [100, 28]
    )
  })

  it("names exactly the axes Ably refused when a batch partly fails", async () => {
    const refused = await ablyAxisChannelName(namespace, axisB)
    const publisher = createAblyInvalidationPublisher({
      rest: restClient(new Set([refused])),
      namespace: "preview",
    })

    const publication = publisher.publish(
      "partial-event",
      stamp({ [axisA]: 1, [axisB]: 1 })
    )

    await expect(publication).rejects.toBeInstanceOf(
      AblyInvalidationPublicationError
    )
    await expect(publication).rejects.toMatchObject({
      attempted: 2,
      failures: [
        {
          axis: axisB,
          channel: refused,
          error: { code: 40160, message: "denied" },
        },
      ],
      message: "Ably did not publish invalidations for 1 of 2 axes: entity/b",
    })
  })

  it("fails every axis of a rejected request and still sends the others", async () => {
    const networkError = new Error("network down")
    const accepted = restClient()
    const rest: AblyRestClient = {
      batchPublish: vi.fn(async (specs: AblyBatchPublishSpec[]) => {
        if (specs.length === 100) throw networkError
        return accepted.batchPublish(specs)
      }),
    }
    const publisher = createAblyInvalidationPublisher({
      rest,
      namespace: "preview",
    })
    const revisions = Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [`axis/${index}`, index])
    )

    let error: unknown = null
    try {
      await publisher.publish("network-event", stamp(revisions))
    } catch (reason) {
      error = reason
    }

    if (!(error instanceof AblyInvalidationPublicationError)) {
      throw new Error("Expected an Ably publication error")
    }
    const { failures, attempted } = error
    expect(attempted).toBe(101)
    expect(failures).toHaveLength(100)
    expect(failures.every((failure) => failure.error === networkError)).toBe(
      true
    )
    expect(accepted.batchPublish).toHaveBeenCalledOnce()
  })
})
