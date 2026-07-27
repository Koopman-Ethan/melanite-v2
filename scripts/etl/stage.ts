// Pulls Xano and Stripe into scripts/etl/staged/, ready for load.ts.
//
// Run: npx tsx scripts/etl/stage.ts
//
// Needs XANO_PAT and STRIPE_SECRET_KEY in .env.local (both read-only). This exists so the
// migration is re-runnable: the real load happens at cutover against data that will have
// moved, and a staging step that can't be repeated on demand is not a migration step.
//
// Xano Free is rate limited, so requests are serialised with a delay and retried on 429.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import '../../envConfig'

const XANO_BASE = 'https://x8ki-letl-twmt.n7.xano.io/api:meta'
const WORKSPACE_ID = 161739

/** Tables load.ts reads. Named, not id'd — ids are resolved at runtime so this keeps
 *  working if a table is rebuilt. */
const XANO_TABLES = [
  'providers',
  'services',
  'provider_services',
  'bookings',
  'checkout_links',
  'transactions',
  'room_bookings',
  'room_transactions',
  'client_packages',
  'client_package_items',
  'package_templates',
  'package_template_items',
  'package_transactions',
  'package_redemptions',
  'training_courses',
  'training_enrollments',
  'memberships',
  'platform_settings',
] as const

const STAGED = join(import.meta.dirname, 'staged')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// HTTP with 429 handling
// ---------------------------------------------------------------------------

async function get<T = unknown>(
  url: string,
  headers: Record<string, string>,
  attempt = 1,
): Promise<T> {
  const res = await fetch(url, { headers })

  if (res.status === 429) {
    if (attempt > 5) throw new Error(`429 after ${attempt} attempts: ${url}`)
    // Honour Retry-After when present, otherwise back off exponentially.
    const retryAfter = Number(res.headers.get('retry-after'))
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 500
    console.log(`    rate limited, waiting ${wait}ms (attempt ${attempt})`)
    await sleep(wait)
    return get(url, headers, attempt + 1)
  }

  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} — ${url}\n${(await res.text()).slice(0, 300)}`)
  }

  return res.json() as Promise<T>
}

// ---------------------------------------------------------------------------
// Xano
// ---------------------------------------------------------------------------

async function stageXano(token: string) {
  const headers = { Authorization: `Bearer ${token}` }

  console.log('xano: resolving table ids')
  const tableIds = new Map<string, number>()
  let page = 1
  for (;;) {
    const body = await get<{ items?: Array<{ id: number; name: string }>; nextPage?: number }>(
      `${XANO_BASE}/workspace/${WORKSPACE_ID}/table?page=${page}&per_page=100`,
      headers,
    )
    for (const t of body.items ?? []) tableIds.set(t.name, t.id)
    if (!body.nextPage) break
    page = body.nextPage
    await sleep(250)
  }

  const missing = XANO_TABLES.filter((n) => !tableIds.has(n))
  if (missing.length) throw new Error(`tables not found in workspace: ${missing.join(', ')}`)

  for (const name of XANO_TABLES) {
    const id = tableIds.get(name)!
    const rows: unknown[] = []
    let p = 1

    for (;;) {
      const body = await get<{ items?: unknown[]; nextPage?: number }>(
        `${XANO_BASE}/workspace/${WORKSPACE_ID}/table/${id}/content?page=${p}&per_page=100`,
        headers,
      )
      rows.push(...(body.items ?? []))
      if (!body.nextPage) break
      p = body.nextPage
      await sleep(250) // stay under the Free-plan limit
    }

    writeFileSync(join(STAGED, 'xano', `${name}.json`), JSON.stringify(rows, null, 2))
    console.log(`  ${name.padEnd(24)} ${String(rows.length).padStart(5)} rows`)
    await sleep(250)
  }
}

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------

/** Stripe list endpoints paginate by `starting_after` on the last id. */
interface StripeRecord {
  id: string
  livemode?: boolean
}

async function stripeList(path: string, key: string, params: Record<string, string> = {}) {
  const headers = { Authorization: `Bearer ${key}` }
  const all: StripeRecord[] = []
  let startingAfter: string | undefined

  for (;;) {
    const qs = new URLSearchParams({ limit: '100', ...params })
    if (startingAfter) qs.set('starting_after', startingAfter)

    const body = await get<{ data: StripeRecord[]; has_more: boolean }>(
      `https://api.stripe.com/v1${path}?${qs}`,
      headers,
    )
    all.push(...body.data)
    if (!body.has_more || body.data.length === 0) break
    startingAfter = body.data[body.data.length - 1].id
  }

  return all
}

async function stageStripe(key: string) {
  const sets: Array<[string, string, Record<string, string>]> = [
    ['payment_intents', '/payment_intents', {}],
    ['refunds', '/refunds', {}],
    ['invoices', '/invoices', {}],
    ['subscriptions', '/subscriptions', { status: 'all' }],
    ['charges', '/charges', {}],
  ]

  for (const [name, path, params] of sets) {
    const rows = await stripeList(path, key, params)
    writeFileSync(join(STAGED, 'stripe', `${name}.json`), JSON.stringify(rows, null, 2))

    const live = rows.filter((r) => r.livemode === false).length
    console.log(
      `  ${name.padEnd(24)} ${String(rows.length).padStart(5)} rows` +
        (live > 0 ? `  WARNING: ${live} test-mode row(s) — is the key live?` : ''),
    )
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const xanoToken = process.env.XANO_PAT
  const stripeKey = process.env.STRIPE_SECRET_KEY
  if (!xanoToken) throw new Error('XANO_PAT is not set — see scripts/etl/README.md')
  if (!stripeKey) throw new Error('STRIPE_SECRET_KEY is not set — see scripts/etl/README.md')

  if (!stripeKey.includes('_live_')) {
    throw new Error(
      'STRIPE_SECRET_KEY is not a live key. Test mode holds none of the real data — ' +
        'staging would silently produce empty files.',
    )
  }

  mkdirSync(join(STAGED, 'xano'), { recursive: true })
  mkdirSync(join(STAGED, 'stripe'), { recursive: true })

  await stageXano(xanoToken)
  console.log('stripe:')
  await stageStripe(stripeKey)

  console.log('\nstaged. next: npx tsx scripts/etl/load.ts')
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
