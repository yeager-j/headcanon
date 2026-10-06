/** A PostgreSQL error to look for: its SQLSTATE and, optionally, the constraint it names. */
export interface PostgresErrorMatch {
  /** Five-character SQLSTATE, such as `"23505"` for a unique violation. */
  readonly code: string
  /** Exact constraint name. Omit it to match the code on any constraint. */
  readonly constraint?: string
}

/**
 * Reports whether `error`, or any error in its `cause` chain, has the expected
 * SQLSTATE and, when given, constraint. A cyclic `cause` chain ends the search.
 *
 * @example
 * createDrizzleMutationAuthority({
 *   db,
 *   scope: (actor: Actor) => actor.userId,
 *   isContentionError: (error) =>
 *     matchesPostgresError(error, { code: "23505", constraint: "notes_slug_key" }),
 * })
 *
 * @param error Any thrown value; its `cause` chain is searched.
 * @param expected The SQLSTATE and optional constraint to find.
 * @returns Whether any error in the chain matches.
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
