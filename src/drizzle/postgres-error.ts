/** SQLSTATE and optional constraint pattern used to classify contention errors. */
export interface PostgresErrorMatch {
  readonly code: string
  readonly constraint?: string
}

/**
 * Matches a PostgreSQL error anywhere in a cycle-safe causal chain.
 * @param error Unknown thrown value or causal chain root.
 * @param expected SQLSTATE and optional constraint to match.
 * @returns Whether the chain contains the expected PostgreSQL error.
 */
export function matchesPostgresError(
  error: unknown,
  expected: PostgresErrorMatch
): boolean {
  let current = error
  const visited = new Set<object>()

  while (
    current !== null &&
    typeof current === "object" &&
    !visited.has(current)
  ) {
    visited.add(current)
    const errorLike = current as {
      readonly code?: unknown
      readonly constraint?: unknown
      readonly cause?: unknown
    }
    if (
      errorLike.code === expected.code &&
      (expected.constraint === undefined ||
        errorLike.constraint === expected.constraint)
    ) {
      return true
    }
    current = errorLike.cause
  }

  return false
}

/** Whether a PostgreSQL error is serialization, deadlock, or lock-timeout contention. */
export function isPostgresContention(error: unknown): boolean {
  return ["40001", "40P01", "55P03"].some((code) =>
    matchesPostgresError(error, { code })
  )
}
