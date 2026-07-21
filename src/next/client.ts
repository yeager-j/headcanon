"use client"

import { unstable_rethrow, useRouter } from "next/navigation"
import { useMemo } from "react"

import type { AnyMutationDefinition, ProtocolDefinition } from "../protocol"
import {
  createPredictedRootWithDeliveryErrorClassifier,
  type PredictedRootOptions,
} from "../react"
import type { RefreshAdapter } from "../refresh"

export const ROUTER_ACCEPTANCE_GRACE_MS = 250

/** @internal Applies Next's control-flow classification at a catch boundary. */
export function rethrowNextControlFlow(error: unknown): void {
  unstable_rethrow(error)
}

/** Binds a predicted root to Next's thrown Server Action control flow. */
export function createNextPredictedRoot<
  const Protocol extends ProtocolDefinition<
    string,
    readonly AnyMutationDefinition[],
    unknown
  >,
>(options: PredictedRootOptions<Protocol>) {
  return createPredictedRootWithDeliveryErrorClassifier(
    options,
    rethrowNextControlFlow
  )
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
