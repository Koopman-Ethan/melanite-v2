import { createHmac } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { hashPassword, needsRehash, verifyPassword } from '@/lib/auth/password'
import { verifyStripeSignature } from '@/lib/stripe/signature'

// Password hashing and webhook signature verification.
//
// Both are short, pure, and the kind of code that fails open — a verifier that accidentally
// returns true is indistinguishable from one that works, until someone forges a request or
// signs in with the wrong password. Neither had a single test.

describe('password hashing', () => {
  it('accepts the right password', async () => {
    const stored = await hashPassword('correct horse battery staple')
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true)
  })

  it('rejects the wrong password', async () => {
    const stored = await hashPassword('correct horse battery staple')
    expect(await verifyPassword('Correct horse battery staple', stored)).toBe(false)
    expect(await verifyPassword('', stored)).toBe(false)
    expect(await verifyPassword('correct horse battery stapl', stored)).toBe(false)
  })

  it('never stores the password itself', async () => {
    const password = 'a-very-distinctive-secret-9182'
    const stored = await hashPassword(password)
    expect(stored).not.toContain(password)
  })

  it('salts, so the same password hashes differently every time', async () => {
    // Without a per-hash salt, two providers with the same password have the same stored value,
    // and one leak cracks both.
    const a = await hashPassword('same password')
    const b = await hashPassword('same password')

    expect(a).not.toBe(b)
    expect(await verifyPassword('same password', a)).toBe(true)
    expect(await verifyPassword('same password', b)).toBe(true)
  })

  it('rejects a null hash instead of letting the account in', async () => {
    // Imported accounts have no usable hash — Xano's is not portable. Those providers must be
    // unable to sign in at all, not able to sign in with anything.
    expect(await verifyPassword('anything', null)).toBe(false)
    expect(await verifyPassword('', null)).toBe(false)
  })

  it('rejects a malformed or truncated stored value', async () => {
    // A corrupted column must fail closed. Returning true here would be a silent auth bypass.
    expect(await verifyPassword('anything', '')).toBe(false)
    expect(await verifyPassword('anything', 'not-a-hash')).toBe(false)
    expect(await verifyPassword('anything', 'scrypt$1$abc')).toBe(false)

    const real = await hashPassword('password')
    expect(await verifyPassword('password', real.slice(0, real.length - 4))).toBe(false)
  })

  it('rejects a hash whose stored digest has been altered', async () => {
    const stored = await hashPassword('password')
    const parts = stored.split('$')
    const digest = Buffer.from(parts[5], 'base64')

    // Flip a bit in the FIRST byte, not the last base64 character — trailing base64 characters
    // can carry padding bits that decode to the same bytes, so changing one proves nothing.
    digest[0] ^= 0xff
    parts[5] = digest.toString('base64')

    expect(await verifyPassword('password', parts.join('$'))).toBe(false)
  })

  it('rejects a digest of the wrong length rather than comparing a prefix', async () => {
    // scrypt ends in PBKDF2, whose output is prefix-stable: a 61-byte derivation is the first
    // 61 bytes of the 64-byte one. Deriving to the STORED length therefore let a truncated
    // hash verify successfully. The correct password was still required, so this was never a
    // bypass — but a damaged hash must fail closed.
    const stored = await hashPassword('password')
    const parts = stored.split('$')
    const digest = Buffer.from(parts[5], 'base64')

    for (const length of [1, 16, 61, 63]) {
      parts[5] = digest.subarray(0, length).toString('base64')
      expect(await verifyPassword('password', parts.join('$'))).toBe(false)
    }
  })

  it('handles long and unicode passwords', async () => {
    const long = 'ß'.repeat(200) + '🔐 pass phrase'
    const stored = await hashPassword(long)
    expect(await verifyPassword(long, stored)).toBe(true)
    expect(await verifyPassword(long.slice(1), stored)).toBe(false)
  })

  it('does not flag a missing hash as needing a rehash', () => {
    // There is nothing to upgrade. An account with no hash cannot sign in at all, and rehashing
    // happens after a SUCCESSFUL login — which is unreachable for these. My first expectation
    // here was wrong about what the function is for.
    expect(needsRehash(null)).toBe(false)
  })

  it('does not flag a freshly created hash', async () => {
    expect(needsRehash(await hashPassword('password'))).toBe(false)
  })
})

describe('stripe signature verification', () => {
  const secret = 'whsec_test_secret'
  const body = '{"id":"evt_1","type":"payment_intent.succeeded"}'

  /** Builds the header Stripe would send. */
  function sign(payload: string, at: number, withSecret = secret): string {
    const v1 = createHmac('sha256', withSecret).update(`${at}.${payload}`).digest('hex')
    return `t=${at},v1=${v1}`
  }

  const now = new Date('2026-07-27T12:00:00Z')
  const nowSeconds = Math.floor(now.getTime() / 1000)

  it('accepts a correctly signed payload', () => {
    const result = verifyStripeSignature(body, sign(body, nowSeconds), secret, now)
    expect(result.valid).toBe(true)
  })

  it('rejects a payload signed with a different secret', () => {
    const header = sign(body, nowSeconds, 'whsec_someone_elses_secret')
    expect(verifyStripeSignature(body, header, secret, now)).toMatchObject({
      valid: false,
      reason: 'mismatch',
    })
  })

  it('rejects a body that was altered after signing', () => {
    // The attack this exists to stop: a real signature attached to a modified payload — say, a
    // larger amount, or a different provider.
    const header = sign(body, nowSeconds)
    const tampered = body.replace('evt_1', 'evt_2')

    expect(verifyStripeSignature(tampered, header, secret, now)).toMatchObject({
      valid: false,
      reason: 'mismatch',
    })
  })

  it('rejects a missing header', () => {
    expect(verifyStripeSignature(body, null, secret, now)).toMatchObject({
      valid: false,
      reason: 'missing-header',
    })
  })

  it.each([
    ['empty', ''],
    ['no signature part', 't=123'],
    ['no timestamp', 'v1=abc'],
    ['nonsense', 'hello'],
    ['non-numeric timestamp', 't=abc,v1=def'],
  ])('rejects a malformed header (%s)', (_name, header) => {
    const result = verifyStripeSignature(body, header, secret, now)
    expect(result.valid).toBe(false)
    expect(['malformed-header', 'missing-header']).toContain(result.reason)
  })

  it('rejects a signature older than the tolerance', () => {
    // Bounds how long a captured request stays replayable.
    const old = nowSeconds - 6 * 60
    expect(verifyStripeSignature(body, sign(body, old), secret, now)).toMatchObject({
      valid: false,
      reason: 'timestamp-out-of-tolerance',
    })
  })

  it('accepts a signature just inside the tolerance', () => {
    const recent = nowSeconds - 4 * 60
    expect(verifyStripeSignature(body, sign(body, recent), secret, now).valid).toBe(true)
  })

  it('rejects a timestamp implausibly far in the future', () => {
    const future = nowSeconds + 6 * 60
    expect(verifyStripeSignature(body, sign(body, future), secret, now)).toMatchObject({
      valid: false,
      reason: 'timestamp-out-of-tolerance',
    })
  })

  it('accepts ANY matching v1 during a secret rotation', () => {
    // Stripe sends several v1 values while a secret is being rotated. Checking only the first
    // would break every rotation — an outage that looks like a signing bug.
    const good = createHmac('sha256', secret).update(`${nowSeconds}.${body}`).digest('hex')
    const other = createHmac('sha256', 'whsec_old').update(`${nowSeconds}.${body}`).digest('hex')

    expect(verifyStripeSignature(body, `t=${nowSeconds},v1=${other},v1=${good}`, secret, now).valid)
      .toBe(true)
    expect(verifyStripeSignature(body, `t=${nowSeconds},v1=${good},v1=${other}`, secret, now).valid)
      .toBe(true)
  })

  it('rejects when none of several signatures match', () => {
    const a = createHmac('sha256', 'wrong-1').update(`${nowSeconds}.${body}`).digest('hex')
    const b = createHmac('sha256', 'wrong-2').update(`${nowSeconds}.${body}`).digest('hex')

    expect(verifyStripeSignature(body, `t=${nowSeconds},v1=${a},v1=${b}`, secret, now).valid)
      .toBe(false)
  })

  it('survives a signature of the wrong length without throwing', () => {
    // `timingSafeEqual` THROWS on a length mismatch rather than returning false. A truncated
    // signature must be a rejection, not a 500 — otherwise anyone can crash the endpoint.
    for (const bogus of ['v1=abcd', 'v1=' + 'a'.repeat(200), 'v1=zz']) {
      const result = verifyStripeSignature(body, `t=${nowSeconds},${bogus}`, secret, now)
      expect(result.valid).toBe(false)
    }
  })

  it('is sensitive to whitespace in the body', () => {
    // Verification must use the RAW body. Parsing and re-serialising changes the bytes, and
    // every signature would fail — the classic reason a webhook endpoint rejects everything.
    const header = sign(body, nowSeconds)
    const reserialised = JSON.stringify(JSON.parse(body), null, 2)

    expect(verifyStripeSignature(reserialised, header, secret, now).valid).toBe(false)
  })
})
