import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { verifyPassword } from '@/lib/auth/password'
import {
  consumeResetToken,
  createResetToken,
  findResetTokenOwner,
  validatePassword,
} from '@/lib/auth/reset'

// Password reset — the one flow that hands out account access by email.
//
// Everything here is either a security property or a way to lose an account. The hashing was
// already unit-tested; the token lifecycle was not, and that is where the interesting failures
// live: a token that survives use, a link that outlives its window, sessions that stay alive
// after a reset triggered because somebody else had them.

const { neon } = await import('@neondatabase/serverless')
const sql = neon(process.env.DATABASE_URL!)

const GOOD = 'correct-horse-42-battery'
let providerId = ''
let email = ''

beforeAll(async () => {
  email = `zz.reset.${Date.now()}@example.com`
  const rows = (await sql.query(
    `INSERT INTO providers (email, password_hash, requires_password_reset, first_name, last_name,
                            role, status, onboarding_step, booking_enabled)
     VALUES ($1, 'placeholder', true, 'Zzreset', 'Subject', 'provider', 'active', 6, false)
     RETURNING id`,
    [email],
  )) as { id: string }[]
  providerId = rows[0].id
})

afterAll(async () => {
  await sql.query(`DELETE FROM password_reset_tokens WHERE provider_id = $1`, [providerId])
  await sql.query(`DELETE FROM sessions WHERE provider_id = $1`, [providerId])
  await sql.query(`DELETE FROM providers WHERE id = $1`, [providerId])
})

describe('validatePassword', () => {
  it('asks for length rather than character classes', () => {
    // A class rule pushes people to `Password1!`, which is worse than a long passphrase.
    expect(validatePassword('short1')).toMatch(/12 characters/)
    expect(validatePassword('a'.repeat(11) + '1')).toBeNull()
  })

  it('still wants a letter and a digit', () => {
    expect(validatePassword('aaaaaaaaaaaaaaa')).toMatch(/letter and one number/)
    expect(validatePassword('123456789012345')).toMatch(/letter and one number/)
  })

  it('refuses absurd lengths', () => {
    // Unbounded input into a KDF is a denial-of-service, not a strong password.
    expect(validatePassword('a1'.repeat(200))).toMatch(/too long/)
  })
})

describe('issuing a token', () => {
  it('says nothing about whether an address is registered', async () => {
    // Returning null rather than throwing is what lets the form answer identically either way.
    // Any difference here turns it into a way to enumerate who works here.
    expect(await createResetToken('nobody.at.all@example.com')).toBeNull()
  })

  it('refuses a deactivated account', async () => {
    await sql.query(`UPDATE providers SET status = 'inactive' WHERE id = $1`, [providerId])
    expect(await createResetToken(email)).toBeNull()
    await sql.query(`UPDATE providers SET status = 'active' WHERE id = $1`, [providerId])
  })

  it('never stores the token itself', async () => {
    const issued = await createResetToken(email)
    expect(issued).not.toBeNull()

    const rows = (await sql.query(
      `SELECT token_hash FROM password_reset_tokens WHERE provider_id = $1`,
      [providerId],
    )) as { token_hash: string }[]

    // Only a hash. A database copy must not be a set of working reset links.
    expect(rows.some((r) => r.token_hash === issued!.token)).toBe(false)
    expect(rows[0].token_hash).toHaveLength(64)
  })

  it('supersedes an earlier outstanding link', async () => {
    const first = await createResetToken(email)
    const second = await createResetToken(email)

    // Two live links to one account widens the window for no benefit.
    expect(await findResetTokenOwner(first!.token)).toBeNull()
    expect(await findResetTokenOwner(second!.token)).not.toBeNull()
  })
})

describe('using a token', () => {
  it('rejects a token that does not exist', async () => {
    expect(await findResetTokenOwner('not-a-real-token')).toBeNull()
    expect(await consumeResetToken('not-a-real-token', GOOD)).toBe(false)
  })

  it('rejects an empty token', async () => {
    // Guarded explicitly: without it, hashing '' would produce a real hash that could
    // conceivably match a row.
    expect(await findResetTokenOwner('')).toBeNull()
  })

  it('rejects an expired token', async () => {
    const issued = await createResetToken(email)
    await sql.query(
      `UPDATE password_reset_tokens SET expires_at = now() - interval '1 minute'
        WHERE provider_id = $1 AND used_at IS NULL`,
      [providerId],
    )
    expect(await findResetTokenOwner(issued!.token)).toBeNull()
    expect(await consumeResetToken(issued!.token, GOOD)).toBe(false)
  })

  it('sets the password and cannot be used a second time', async () => {
    const issued = await createResetToken(email)
    expect(await consumeResetToken(issued!.token, GOOD)).toBe(true)

    const [row] = (await sql.query(
      `SELECT password_hash, requires_password_reset FROM providers WHERE id = $1`,
      [providerId],
    )) as { password_hash: string; requires_password_reset: boolean }[]

    expect(await verifyPassword(GOOD, row.password_hash)).toBe(true)
    // An imported account is forced through a reset; completing one clears that.
    expect(row.requires_password_reset).toBe(false)

    // Replay must fail. A link sitting in an inbox is not a spare key.
    expect(await consumeResetToken(issued!.token, 'another-password-99')).toBe(false)
    const [after] = (await sql.query(`SELECT password_hash FROM providers WHERE id = $1`, [
      providerId,
    ])) as { password_hash: string }[]
    expect(after.password_hash).toBe(row.password_hash)
  })

  it('ends every existing session', async () => {
    // The point of the whole flow when it was triggered because someone else had access.
    // Leaving their session alive would defeat it.
    await sql.query(
      `INSERT INTO sessions (provider_id, token_hash, expires_at)
       VALUES ($1, $2, now() + interval '7 days')`,
      [providerId, `zzreset${Date.now()}`],
    )

    const before = (await sql.query(
      `SELECT count(*)::int AS n FROM sessions WHERE provider_id = $1`,
      [providerId],
    )) as { n: number }[]
    expect(before[0].n).toBeGreaterThan(0)

    const issued = await createResetToken(email)
    expect(await consumeResetToken(issued!.token, 'third-password-123')).toBe(true)

    const after = (await sql.query(
      `SELECT count(*)::int AS n FROM sessions WHERE provider_id = $1`,
      [providerId],
    )) as { n: number }[]
    expect(after[0].n).toBe(0)
  })
})
