"use client"

import { unstable_rethrow, useRouter } from "next/navigation"
import { useMemo } from "react"

import { err, ok, type Result } from "@workspace/result"

import type {
  MutationEnvelope,
  MutationExecutorError,
  MutationTerminalOutcome,
} from "../authority"
import type {
  AnyMutationDefinition,
  MutationRefusalOf,
  ProtocolDefinition,
  ProtocolInvocation,
} from "../protocol"
import {
  createPredictedRootWithDeliveryErrorClassifier,
  RetryableDeliveryError,
  type PredictedRootOptions,
} from "../react"
import type { RefreshAdapter } from "../refresh"
import type { AcceptedStamp } from "../revisions"

export const ROUTER_ACCEPTANCE_GRACE_MS = 250

/** @internal Applies Next's control-flow classification at a catch boundary. */
export function rethrowNextControlFlow(error: unknown): void {
  unstable_rethrow(error)
}

/** Binds a predicted root to Next's thrown Server Action control flow. */
export function createNextPredictedRoot<
  const Protocol extends ProtocolDefinition<
    string,
    readonly AnyMutationDefinition[]
  >,
>(options: PredictedRootOptions<Protocol>) {
  return createPredictedRootWithDeliveryErrorClassifier(
    options,
    rethrowNextControlFlow
  )
}

type ProtocolMutation<Protocol> =
  Protocol extends ProtocolDefinition<string, infer Mutations>
    ? Mutations[number]
    : never

/** Adapts the generated Server Action to a predicted root's delivery seam. */
export function createNextMutationSender<
  const Protocol extends ProtocolDefinition<
    string,
    readonly AnyMutationDefinition[]
  >,
>(
  action: (
    envelope: MutationEnvelope<ProtocolInvocation<Protocol>>
  ) => Promise<
    Result<
      Exclude<
        MutationTerminalOutcome<MutationRefusalOf<ProtocolMutation<Protocol>>>,
        { readonly kind: "denied" }
      >,
      MutationExecutorError
    >
  >
): (
  envelope: MutationEnvelope<ProtocolInvocation<Protocol>>
) => Promise<
  Result<AcceptedStamp, MutationRefusalOf<ProtocolMutation<Protocol>>>
> {
  return async (envelope) => {
    const outcome = await action(envelope)
    if (!outcome.ok) {
      if (outcome.error.code === "contention") {
        throw new RetryableDeliveryError("mutation authority contention")
      }
      throw new Error(
        `mutation executor refused the envelope: ${outcome.error.code}`
      )
    }

    return outcome.value.kind === "accepted"
      ? ok(outcome.value.stamp)
      : err(outcome.value.error)
  }
}

/** Requests a new RSC payload through the App Router. */
export function useRouterRefresh(): RefreshAdapter {
  const router = useRouter()

  return useMemo(
    () => ({
      acceptanceGraceMs: ROUTER_ACCEPTANCE_GRACE_MS,
      request: () => router.refresh(),
    }),
    [router]
  )
}
