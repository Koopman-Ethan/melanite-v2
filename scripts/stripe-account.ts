import '../envConfig'

import { currentEnv } from '../lib/env-guard'

// Which Stripe account each key points at, and whether it is live.
//
//   npx tsx --tsconfig scripts/tsconfig.json scripts/stripe-account.ts
//
// WHY THIS EXISTS
//
// `requireEnv` proves which DATABASE is configured and says nothing about which Stripe account
// the keys reach — they are set separately and nothing checks they agree. A test key against the
// production database means every charge silently fails; a live key against dev means a test
// charges somebody's real card.
//
// It also matters that the two keys reach the SAME account. The read key is used by the ETL and
// the write key by everything that moves money; pointed at different accounts, the second would
// be charging customers the first has never heard of.
//
// From cutover the write key starts DEBITING providers rather than crediting Melanite, which is
// the first time a mistake here costs somebody else money.
//
// READ ONLY.

interface Account {
  id: string
  settings?: { dashboard?: { display_name?: string } }
}

async function describe(label: string, key: string | undefined): Promise<string | null> {
  if (!key) {
    console.log(`  ${label.padEnd(26)} not set`)
    return null
  }

  const mode = key.includes('_live_') ? 'LIVE' : key.includes('_test_') ? 'test' : 'unknown mode'

  const res = await fetch('https://api.stripe.com/v1/account', {
    headers: { Authorization: `Bearer ${key}` },
  })
  const body = (await res.json()) as Account & { error?: { message: string } }

  if (body.error) {
    console.log(`  ${label.padEnd(26)} ${mode} — could not read: ${body.error.message}`)
    return null
  }

  const name = body.settings?.dashboard?.display_name ?? '(unnamed)'
  console.log(`  ${label.padEnd(26)} ${mode}  ${body.id}  ${name}`)
  return body.id
}

async function main() {
  const env = currentEnv() ?? 'unset'
  console.log(`MELANITE_ENV=${env}\n`)

  const read = await describe('STRIPE_SECRET_KEY', process.env.STRIPE_SECRET_KEY)
  const write = await describe('STRIPE_SECRET_KEY_WRITE', process.env.STRIPE_SECRET_KEY_WRITE)

  console.log('')

  const writeIsLive = process.env.STRIPE_SECRET_KEY_WRITE?.includes('_live_') ?? false

  // The one genuinely dangerous combination.
  if (env === 'dev' && writeIsLive) {
    console.error('DEV database with a LIVE write key. A test here would charge a real card.')
    process.exitCode = 1
    return
  }

  if (read && write && read !== write) {
    console.log('Read and write keys are on different accounts, which is the intended setup:')
    console.log('  the read key is live because the ETL needs the real account’s data,')
    console.log('  the write key is a sandbox so nothing run locally can take money.')
  }

  if (env === 'prod' && !writeIsLive) {
    console.log('')
    console.log('This shell points at the PRODUCTION database with a TEST write key, which is')
    console.log('correct — nothing run from here can charge anybody.')
    console.log('')
    console.log('THE DEPLOYED app uses its own key from Vercel and this script cannot see it.')
    console.log('Before cutover, confirm STRIPE_SECRET_KEY_WRITE in Vercel production is LIVE:')
    console.log('from that day it debits providers rather than crediting Melanite.')
    return
  }

  console.log('')
  console.log('Nothing dangerous about this combination.')
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : err}`)
  process.exitCode = 1
})
