import { createHmac, timingSafeEqual } from 'node:crypto'

// Stripe webhook signature verification.
//
// Deliberately hand-rolled rather than pulling in the Stripe SDK: this is the only Stripe
// primitive the app needs on the receive side, and the algorithm is short and stable. v1 does
// the same in XanoScript.
//
// The scheme: Stripe sends `Stripe-Signature: t=<ts>,v1=<hex>`, where the hex is
// HMAC-SHA256(`${t}.${rawBody}`) keyed with the endpoint's signing secret. Verification MUST
// use the raw body — parsing and re-serialising changes the bytes and every signature fails.

export interface SignatureResult {
  valid: boolean
  reason?: 'missing-header' | 'malformed-header' | 'mismatch' | 'timestamp-out-of-tolerance'
  timestamp?: number
}

/** Five minutes, Stripe's own default. Bounds how long a captured request stays replayable if
 *  it is ever recorded off the wire. */
const TOLERANCE_SECONDS = 5 * 60

export function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
  now: Date = new Date(),
): SignatureResult {
  if (!signatureHeader) return { valid: false, reason: 'missing-header' }

  // `t=1234,v1=abc,v1=def` — more than one v1 appears during a secret rotation, and ANY of
  // them matching is valid. Checking only the first would break every rotation.
  const parts = signatureHeader.split(',').map((p) => p.trim())
  const timestamp = parts.find((p) => p.startsWith('t='))?.slice(2)
  const signatures = parts.filter((p) => p.startsWith('v1=')).map((p) => p.slice(3))

  if (!timestamp || signatures.length === 0) return { valid: false, reason: 'malformed-header' }

  const ts = Number(timestamp)
  if (!Number.isFinite(ts)) return { valid: false, reason: 'malformed-header' }

  if (Math.abs(Math.floor(now.getTime() / 1000) - ts) > TOLERANCE_SECONDS) {
    return { valid: false, reason: 'timestamp-out-of-tolerance', timestamp: ts }
  }

  const expected = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest()

  const matched = signatures.some((candidate) => {
    let provided: Buffer
    try {
      provided = Buffer.from(candidate, 'hex')
    } catch {
      return false
    }
    // Length check first: timingSafeEqual throws on a mismatch rather than returning false.
    if (provided.length !== expected.length) return false
    return timingSafeEqual(provided, expected)
  })

  return matched ? { valid: true, timestamp: ts } : { valid: false, reason: 'mismatch', timestamp: ts }
}
