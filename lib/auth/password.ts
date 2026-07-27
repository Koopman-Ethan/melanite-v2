// Deliberately NOT marked `server-only`, unlike session.ts and dal.ts.
//
// This module holds no secrets and touches no database — it is pure key derivation. It also
// has to be callable from `scripts/set-password.ts`, which bootstraps the first admin, and
// `server-only` throws outside the Next runtime. Client bundling is prevented anyway: it
// imports `node:crypto`, which cannot resolve in a browser build.

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>

// scrypt from node:crypto rather than argon2id.
//
// argon2id is the stronger default, but every Node binding for it is a native module, and
// this project builds on Windows without a guaranteed toolchain. scrypt is memory-hard,
// built in, has no build step, and is an accepted choice under the OWASP password storage
// guidance. The encoded format below carries its own parameters, so raising the cost — or
// moving to argon2id later — is a matter of re-hashing on next successful login, not a
// migration.
//
// N=2^16 with r=8 costs roughly 64 MB per hash. maxmem must be raised to allow it; Node's
// default ceiling is 32 MB and would reject these parameters outright.
const PARAMS = { N: 2 ** 16, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }
const KEY_LENGTH = 64
const SALT_LENGTH = 16

/** `scrypt$N$r$p$salt$hash`, both parts base64. Self-describing so old hashes stay verifiable
 *  after the parameters change. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH)
  const derived = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, PARAMS)
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$')
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  // Providers imported from Xano have no hash — its HMAC keying is undocumented, so those
  // passwords are not portable. They must go through a reset rather than ever matching here.
  if (!stored) return false

  const [scheme, n, r, p, saltB64, hashB64] = stored.split('$')
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false

  const expected = Buffer.from(hashB64, 'base64')

  // The stored digest must be exactly the length we write. Deriving to `expected.length`
  // instead — as this did — makes the comparison length a property of the stored value rather
  // than of the algorithm, and scrypt's final PBKDF2 step is prefix-stable, so a digest
  // truncated to 61 bytes still matches the first 61 bytes of the real one. A corrupted or
  // truncated column then verifies successfully instead of failing closed.
  //
  // Not an authentication bypass — the correct password is still required — but a hash that
  // has been damaged should be rejected, and the work factor should never be negotiable by
  // whatever happens to be in the database.
  if (expected.length !== KEY_LENGTH) return false

  const derived = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), KEY_LENGTH, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: PARAMS.maxmem,
  })

  // Constant time — a length mismatch alone would otherwise leak information.
  if (derived.length !== expected.length) return false
  return timingSafeEqual(derived, expected)
}

/** True when a stored hash was made with weaker parameters than the current ones, so it can
 *  be transparently upgraded on the next successful login. */
export function needsRehash(stored: string | null): boolean {
  if (!stored) return false
  const [scheme, n, r, p] = stored.split('$')
  return scheme !== 'scrypt' || Number(n) < PARAMS.N || Number(r) < PARAMS.r || Number(p) < PARAMS.p
}
