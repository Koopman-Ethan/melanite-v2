import { createHmac } from 'node:crypto'
import { createServer } from 'node:http'

import '../envConfig'

// A local relay between `stripe listen` and the running dev server.
//
// Why this exists: the Stripe CLI mints its OWN webhook signing secret, which is not the one in
// .env.local, so events it forwards straight to the app fail verification. The obvious fixes
// are both worse — a second dev server is refused by Next (one per directory), and swapping
// STRIPE_WEBHOOK_SECRET means editing someone's env file and restarting their server.
//
// So: receive the CLI's POST, verify it against the CLI secret, then re-sign the UNCHANGED raw
// bytes with the app's own secret and pass it on. The app verifies normally and has no idea
// this is here.
//
// What this does and does not prove. It delivers real Stripe event payloads over real HTTP into
// the real handler, which is the part that has never been exercised. It does NOT prove that
// Stripe's own signature bytes verify — that is what the unit tests in test/security.test.ts
// cover, against captured payloads.
//
//   npx tsx --tsconfig scripts/tsconfig.json scripts/webhook-bridge.ts <cli-secret> [port]

const CLI_SECRET = process.argv[2]
const PORT = Number(process.argv[3] ?? 3114)
const TARGET = process.env.WEBHOOK_TARGET ?? 'http://localhost:3113/api/webhooks/stripe'
const APP_SECRET = process.env.STRIPE_WEBHOOK_SECRET

if (!CLI_SECRET) throw new Error('Pass the CLI signing secret as the first argument')
if (!APP_SECRET) throw new Error('STRIPE_WEBHOOK_SECRET is not set')

function sign(payload: string, secret: string): string {
  const timestamp = Math.floor(Date.now() / 1000)
  const digest = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex')
  return `t=${timestamp},v1=${digest}`
}

/** Rejects anything not signed by the CLI. The relay is a hole in the app's only authenticated
 *  endpoint for as long as it runs; it should not accept what Stripe would not. */
function fromCli(payload: string, header: string | undefined): boolean {
  if (!header) return false
  const timestamp = /t=(\d+)/.exec(header)?.[1]
  if (!timestamp) return false
  const expected = createHmac('sha256', CLI_SECRET!)
    .update(`${timestamp}.${payload}`)
    .digest('hex')
  return header.includes(expected)
}

createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', async () => {
    // Concatenated as bytes, never as a parsed object: re-serialising JSON changes the bytes
    // and the HMAC covers the bytes.
    const raw = Buffer.concat(chunks).toString('utf8')

    if (!fromCli(raw, req.headers['stripe-signature'] as string | undefined)) {
      console.log('  refused — not signed by the CLI')
      res.writeHead(403).end()
      return
    }

    const type = (() => {
      try {
        return (JSON.parse(raw) as { type?: string }).type ?? '?'
      } catch {
        return '?'
      }
    })()

    const forwarded = await fetch(TARGET, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': sign(raw, APP_SECRET!),
      },
      body: raw,
    })

    console.log(`  ${type} -> ${forwarded.status} ${await forwarded.text()}`)
    res.writeHead(forwarded.status).end()
  })
}).listen(PORT, () => {
  console.log(`bridge on :${PORT} -> ${TARGET}`)
})
