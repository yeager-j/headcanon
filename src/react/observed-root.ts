"use client"

import type { InvalidationAdapter } from "../core/invalidation"
import type { Canon } from "../core/revisions"
import {
  useIncorporation,
  type IncorporationStatus,
  type RefreshAdapter,
} from "./refresh"

/** Read-only state and lifecycle controls exposed by an observed root. */
export interface ObservedRoot<State> {
  /** The authoritative canon's state. */
  readonly value: State
  /**
   * Refreshes now with a fresh attempt budget when canon does not meet the
   * root's requirements, such as after a stall.
   */
  readonly retryRefresh: () => void
  /** Freshness and invalidation status of the mounted canon. */
  readonly status: IncorporationStatus
}

/** Refresh and optional invalidation dependencies for an observed root. */
export interface ObservedRootOptions {
  /**
   * A React hook the root calls during every render to get its refresh
   * carrier. It must follow the Rules of Hooks: pass `useRouterRefresh`, or a
   * function that calls `useSnapshotRefresh`. The adapter returned on the
   * latest render serves each request.
   */
  readonly refresh: () => RefreshAdapter
  /**
   * Push-invalidation transport for canon's axes. Without it,
   * `status.invalidations` is `disabled`.
   */
  readonly invalidations?: InvalidationAdapter
}

/**
 * Creates a read-only React observed-root hook.
 * @param options Refresh and optional invalidation dependencies.
 * @returns A hook exposing authoritative state and incorporation status without mutation controls.
 */
export function createObservedRoot(options: ObservedRootOptions) {
  return function useObservedRoot<State>({
    canon,
  }: {
    readonly canon: Canon<State>
  }): ObservedRoot<State> {
    const useRefresh = options.refresh
    const refresh = useRefresh()
    const incorporation = useIncorporation(
      canon,
      refresh,
      options.invalidations
    )

    return {
      value: canon.value,
      retryRefresh: incorporation.retryRefresh,
      status: incorporation.status,
    }
  }
}
