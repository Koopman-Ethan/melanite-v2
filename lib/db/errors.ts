import 'server-only'

// Postgres error codes, read through however many wrappers are in the way.
//
// Drizzle wraps the driver's error in a plain `Error` whose message is the failed SQL, and puts
// the NeonDbError on `.cause`. So `err.code` is undefined and the message contains the query
// rather than the code — which means the obvious check,
// `String(err.code ?? err).includes('23505')`, never matches.
//
// That is not hypothetical. Two places in this codebase were written that way and neither had
// ever caught anything: a duplicate subscription invoice threw instead of being recognised as
// already-recorded, and a lost race for a laser slot would have shown a crash instead of
// "someone just booked that slot".

/** Walks the cause chain looking for a Postgres SQLSTATE. */
function sqlState(err: unknown): string | null {
  let current: unknown = err
  for (let depth = 0; depth < 5 && current; depth++) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code
    current = (current as { cause?: unknown }).cause
  }
  return null
}

/** 23505 — a unique index rejected the row. Somebody else got there first. */
export function isUniqueViolation(err: unknown): boolean {
  return sqlState(err) === '23505'
}

/** 23P01 — an EXCLUDE constraint rejected the row, i.e. the time slot is taken. */
export function isExclusionViolation(err: unknown): boolean {
  return sqlState(err) === '23P01'
}
