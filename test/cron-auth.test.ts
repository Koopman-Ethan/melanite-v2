import { describe, expect, it } from 'vitest'

import { checkCronBearer } from '@/lib/cron/auth'

// Who may trigger a scheduled job.
//
// Worth its own file because the interesting cases are all failures, and one of them —
// a token of the wrong LENGTH — throws rather than returning false if the length is not
// checked before `timingSafeEqual`. That is the bug this file exists to keep fixed.

const SECRET = 'a'.repeat(64)

describe('the cron bearer check', () => {
  it('refuses when no secret is configured, rather than letting anybody in', () => {
    expect(checkCronBearer(`Bearer ${SECRET}`, undefined)).toEqual({
      ok: false,
      reason: 'not-configured',
    })
    expect(checkCronBearer(`Bearer ${SECRET}`, '   ')).toEqual({
      ok: false,
      reason: 'not-configured',
    })
  })

  it('accepts the configured token', () => {
    expect(checkCronBearer(`Bearer ${SECRET}`, SECRET)).toEqual({ ok: true })
  })

  it('rejects a missing or malformed header', () => {
    expect(checkCronBearer(null, SECRET).ok).toBe(false)
    expect(checkCronBearer('', SECRET)).toEqual({ ok: false, reason: 'missing' })
    expect(checkCronBearer(`Basic ${SECRET}`, SECRET)).toEqual({ ok: false, reason: 'missing' })
    expect(checkCronBearer('Bearer    ', SECRET)).toEqual({ ok: false, reason: 'missing' })
  })

  it('rejects a token of a DIFFERENT LENGTH without throwing', () => {
    // `timingSafeEqual` throws on unequal buffer lengths. A shorter token is the most obvious
    // thing an attacker sends, and it must be a 401 rather than a 500.
    expect(() => checkCronBearer('Bearer short', SECRET)).not.toThrow()
    expect(checkCronBearer('Bearer short', SECRET)).toEqual({ ok: false, reason: 'mismatch' })
  })

  it('rejects a same-length token that is wrong', () => {
    expect(checkCronBearer(`Bearer ${'b'.repeat(64)}`, SECRET)).toEqual({
      ok: false,
      reason: 'mismatch',
    })
  })
})
