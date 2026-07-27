import 'server-only'

// The Stripe write client.
//
// Deliberately separate from the read key. STRIPE_SECRET_KEY is a RESTRICTED, read-only key
// used to read the account during the migration; giving that same variable write scope would
// silently widen what every existing call can do. A write key is its own decision and its own
// variable.
//
// Reads still go through the restricted key. Only the calls below can move money.

const API = 'https://api.stripe.com/v1'

export class StripeNotConfiguredError extends Error {
  constructor() {
    super('Stripe writes are not configured')
    this.name = 'StripeNotConfiguredError'
  }
}

export class StripeApiError extends Error {
  constructor(
    readonly status: number,
    readonly stripeCode: string | undefined,
    message: string,
  ) {
    super(message)
    this.name = 'StripeApiError'
  }
}

export function writeKey(): string | null {
  const key = process.env.STRIPE_SECRET_KEY_WRITE
  return key && key.length > 0 ? key : null
}

export function stripeWritesEnabled(): boolean {
  return writeKey() !== null
}

/** Flattens a nested object into Stripe's bracketed form-encoding.
 *
 *  `{ metadata: { provider_id: 'x' } }` becomes `metadata[provider_id]=x`. Doing this properly
 *  avoids the string-concatenated keys v1 had to write by hand, which are easy to get subtly
 *  wrong and impossible to typecheck. */
function encode(params: Record<string, unknown>, prefix = ''): string[] {
  const parts: string[] = []

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    const name = prefix ? `${prefix}[${key}]` : key

    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (typeof item === 'object' && item !== null) {
          parts.push(...encode(item as Record<string, unknown>, `${name}[${i}]`))
        } else {
          parts.push(`${encodeURIComponent(`${name}[${i}]`)}=${encodeURIComponent(String(item))}`)
        }
      })
    } else if (typeof value === 'object') {
      parts.push(...encode(value as Record<string, unknown>, name))
    } else {
      parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`)
    }
  }

  return parts
}

export interface StripePostOptions {
  /** Makes the call safe to retry.
   *
   *  Without one, a request that times out after Stripe processed it becomes a SECOND charge
   *  or a second subscription when retried — the client has no way to tell "never arrived"
   *  from "arrived, response lost". Stripe replays the original response for 24 hours against
   *  the same key. Every money-moving call below passes one derived from what it is doing, so
   *  the same intent produces the same key. */
  idempotencyKey?: string
  /** Acts on behalf of a connected account, for Connect calls. */
  stripeAccount?: string
}

export async function stripePost<T>(
  path: string,
  params: Record<string, unknown>,
  options: StripePostOptions = {},
): Promise<T> {
  const key = writeKey()
  if (!key) throw new StripeNotConfiguredError()

  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  }
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey
  if (options.stripeAccount) headers['Stripe-Account'] = options.stripeAccount

  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers,
    body: encode(params).join('&'),
  })

  const body = (await res.json()) as {
    error?: { message?: string; code?: string; type?: string }
  } & T

  if (!res.ok) {
    throw new StripeApiError(
      res.status,
      body.error?.code,
      body.error?.message ?? `Stripe returned ${res.status}`,
    )
  }

  return body
}

/** Turns a Stripe failure into something safe to show a provider.
 *
 *  Stripe's own messages are written for developers and occasionally leak account details, so
 *  the raw text is logged and a plain sentence is returned. */
export function friendlyStripeError(err: unknown, fallback: string): string {
  if (err instanceof StripeNotConfiguredError) {
    return 'Payments aren’t connected yet. Contact Melanite and they’ll get you set up.'
  }

  if (err instanceof StripeApiError) {
    console.error(`[stripe] ${err.status} ${err.stripeCode ?? ''}: ${err.message}`)
    return fallback
  }

  console.error('[stripe] unexpected failure', err)
  return fallback
}
