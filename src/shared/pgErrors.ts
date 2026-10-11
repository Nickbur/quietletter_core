/**
 * Postgres SQLSTATE of a failed query. drizzle-orm ≥ 0.44 wraps driver errors in a
 * `DrizzleQueryError` whose `cause` is the pg error, so the code is read from either.
 */
export function pgErrorCode(err: unknown): string | undefined {
    const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
    if (typeof e?.code === 'string') return e.code;
    if (typeof e?.cause?.code === 'string') return e.cause.code;
    return undefined;
}

/** `23505 unique_violation`. */
export function isUniqueViolation(err: unknown): boolean {
    return pgErrorCode(err) === '23505';
}
