import { mkdirSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

import { chromium, type Page } from '@playwright/test'
import { neon } from '@neondatabase/serverless'

import '../envConfig'

// A watchable walkthrough of the whole provider path: admin sends an invite, the provider
// accepts it, sets a password, and works through all six setup steps to an active account.
//
// Runs headed and slowly on purpose — the point is to be seen. Every screen is also captured
// to demo/ so it can be looked at afterwards.
//
//   npx tsx --tsconfig scripts/tsconfig.json scripts/demo-onboarding.ts
//
// The provider it creates is a throwaway on example.com and is deleted at the end.

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3113'
const SHOTS = join(process.cwd(), 'demo')
const query = neon(process.env.DATABASE_URL!)

/** The real invite, left live and unaccepted so it can actually be used. */
const REAL_INVITE = process.argv[2] ?? null

const demoEmail = `zz.onboard.demo.${Date.now()}@example.com`
const demoPassword = `Demo-Provider-${randomBytes(4).toString('hex')}!`

const captured: { file: string; label: string; note: string }[] = []

async function capture(page: Page, label: string, note = '') {
  const n = captured.length + 1
  const file = `${String(n).padStart(2, '0')}-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.jpg`
  await page.screenshot({ path: join(SHOTS, file), type: 'jpeg', quality: 80, fullPage: true })
  captured.push({ file, label, note })
  console.log(`  ${file}`)
}

/** A contact sheet, written next to the images rather than embedding them.
 *
 *  Inlining 1.4MB of screenshots as data URIs would make a page nothing wants to load. These
 *  are local files; a local page that points at them is the honest shape. */
function writeContactSheet() {
  const cards = captured
    .map(
      (c) => `    <figure>
      <img src="${c.file}" alt="${c.label}" loading="lazy">
      <figcaption><b>${c.label}</b>${c.note ? `<span>${c.note}</span>` : ''}</figcaption>
    </figure>`,
    )
    .join('\n')

  writeFileSync(
    join(SHOTS, 'index.html'),
    `<!doctype html><meta charset="utf-8"><title>Melanite onboarding walkthrough</title>
<style>
  :root { color-scheme: dark }
  body { margin:0; padding:2.5rem 1.5rem; background:#0f0f0f; color:#ddd;
         font:16px/1.55 system-ui, sans-serif }
  header { max-width:1100px; margin:0 auto 2.5rem }
  h1 { margin:0 0 .5rem; font-size:1.6rem }
  header p { margin:0; color:#a8a8a8; max-width:60ch }
  main { max-width:1100px; margin:0 auto; display:grid; gap:2.5rem }
  figure { margin:0 }
  img { width:100%; border:1px solid #2a2a2a; border-radius:10px; display:block }
  figcaption { margin-top:.65rem; font-size:.85rem; color:#a8a8a8 }
  figcaption b { color:#b8965a; font-weight:600; text-transform:capitalize }
  figcaption span { display:block; margin-top:.2rem }
</style>
<header>
  <h1>Provider onboarding, end to end</h1>
  <p>An admin issues an invite; a signed-out provider accepts it and works through all six
     setup steps to an active account. Captured from a live run against the dev database.</p>
</header>
<main>
${cards}
</main>
`,
    'utf-8',
  )
  console.log('\n  demo/index.html')
}

async function main() {
  mkdirSync(SHOTS, { recursive: true })

  const browser = await chromium.launch({ channel: 'chrome', headless: false, slowMo: 350 })

  // ---------------------------------------------------------------- admin ---
  const adminCtx = await browser.newContext({
    storageState: 'e2e/.auth/admin.json',
    viewport: { width: 1280, height: 900 },
  })
  const admin = await adminCtx.newPage()

  console.log('\nADMIN — inviting a provider')
  await admin.goto(`${BASE}/app/admin/tools`)
  await admin.waitForLoadState('networkidle')
  await capture(admin, 'admin tools', 'Invite is the first tab — the only door into the system, since there is no self-service signup.')

  if (REAL_INVITE) {
    console.log(`  sending a live invite to ${REAL_INVITE}`)
    await admin.getByLabel('Their email').fill(REAL_INVITE)
    await admin.getByRole('button', { name: 'Send invite' }).click()
    await admin.getByText(/Invite emailed|Invite created/).waitFor()
    await capture(admin, 'real invite sent')
  }

  await admin.getByLabel('Their email').fill(demoEmail)
  await admin.getByRole('button', { name: 'Send invite' }).click()
  await admin.locator('p', { hasText: '/onboard/' }).waitFor()
  await capture(admin, 'invite issued with link', 'The link is shown whichever way the email went. example.com is refused by Resend, and an admin who cannot see the link cannot rescue that.')

  // Recover the link the way an admin would when the email did not arrive.
  await admin.reload()
  await admin.waitForLoadState('networkidle')
  const row = admin.locator('li', { hasText: demoEmail }).first()
  await row.getByRole('button', { name: 'Show link' }).click()
  const link = await admin.locator('p', { hasText: '/onboard/' }).textContent()
  await capture(admin, 'link recovered after reload', 'Show link reads the token back on demand. Before this, the link existed only in the response that created it.')

  const url = (link ?? '').trim()
  console.log(`  invite link: ${url}`)

  // ------------------------------------------------------------- provider ---
  // A separate context: this is a different person, on a different machine, signed out.
  const providerCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await providerCtx.newPage()

  console.log('\nPROVIDER — accepting the invite')
  await page.goto(url)
  await capture(page, 'step 1 create password', 'The email comes from the invite and cannot be edited — the invite decides whose account this is.')

  await page.getByLabel('Create password', { exact: true }).fill(demoPassword)
  await page.getByLabel('Confirm password').fill(demoPassword)
  await capture(page, 'step 1 requirements met', 'Each rule mirrors what the server enforces, and says met or not met in text as well as colour.')
  await page.getByRole('button', { name: 'Activate account' }).click()

  console.log('  step 2 — profile')
  await page.waitForURL(/onboarding\/profile/)
  await page.getByLabel('First name').fill('Dana')
  await page.getByLabel('Last name').fill('Reyes')
  await page.getByLabel('Phone number').fill('(208) 555-0134')
  await page.getByLabel('Professional credentials').fill('RN, BSN')
  await capture(page, 'step 2 profile', 'No sidebar and one logo: these pages sit outside the app shell, so there is nothing to navigate to that would not be a dead end.')
  await page.getByRole('button', { name: /continue/i }).click()

  console.log('  step 3 — licence')
  await page.waitForURL(/onboarding\/license/)
  await page.getByLabel('Licence number').fill('RN-208-44917')
  await page.getByLabel('Licence state').fill('Idaho')
  await page.getByLabel('Licence expiry').fill('2028-04-30')
  await page.getByLabel('Malpractice insurance provider').fill('NSO')
  await capture(page, 'step 3 licence', 'An already-expired licence is refused outright rather than stored and flagged. Documents are emailed to Melanite — upload comes later.')
  await page.getByRole('button', { name: /continue to stripe/i }).click()

  console.log('  step 4 — Stripe')
  await page.waitForURL(/onboarding\/stripe/)
  await capture(page, 'step 4 stripe not connected', 'Stripe is required to be paid at all. Coming back from Stripe now returns here rather than dumping a half-set-up provider into Account.')

  // Stripe's own hosted flow is not driven here — that is Stripe's form, and completing it for
  // a fake person would create a real Connect account. What is shown instead is the state a
  // provider comes BACK to, which is this app's screen and this app's decision.
  await query.query(`UPDATE providers SET stripe_account_id = $1 WHERE email = $2`, [
    `acct_demo_${randomBytes(6).toString('hex')}`,
    demoEmail,
  ])
  await page.reload()
  await capture(page, 'step 4 stripe verifying', 'Connected but unverified is where nearly everyone sits for a few minutes. It must not block them, so it does not.')
  await page.getByRole('button', { name: 'Next step' }).click()

  console.log('  step 5 — medical director')
  await page.waitForURL(/onboarding\/director/)
  await capture(page, 'step 5 melanite director', 'Melanite’s director at $150/month, or bring your own.')
  await page.getByRole('button', { name: /use my own director/i }).click()
  await capture(page, 'step 5 own director', 'Both paths carry the same warning: an active subscription alone does not unlock booking.')
  await page.getByRole('button', { name: /continue to services/i }).click()

  console.log('  step 6 — services')
  await page.waitForURL(/onboarding\/services/)
  await capture(page, 'step 6 services none chosen', 'Nothing selected means nothing to sell, so Finish setup stays disabled rather than failing on submit.')

  const boxes = page.locator('input[type="checkbox"]')
  const count = Math.min(await boxes.count(), 2)
  for (let i = 0; i < count; i++) await boxes.nth(i).check()
  for (const [i, price] of ['250', '175'].slice(0, count).entries()) {
    await page.getByLabel('Your price').nth(i).fill(price)
  }
  await capture(page, 'step 6 services priced', 'Melanite suggests the duration; the provider sets the price.')
  await page.getByRole('button', { name: /finish setup/i }).click()

  console.log('  done')
  await page.waitForURL(/onboarding\/done/)
  await capture(page, 'setup complete', 'Account is active. The first thing it says is that documents still have to reach Melanite — not a victory lap.')

  // What the provider sees the moment they are in: an account that works, and gates that do not
  // open until Melanite has the documents.
  await page.getByRole('link', { name: /go to my dashboard/i }).click()
  await page.waitForURL(/\/app\/dashboard/)
  await page.waitForLoadState('networkidle')
  await capture(page, 'dashboard blocked on documents', 'And this is why. Active is not booking-enabled: that stays a manual flip once Keoni has the paperwork.')

  // ------------------------------------------------------------------ db ---
  const [state] = (await query.query(
    `SELECT status, onboarding_step, booking_enabled, medical_director_type,
            (SELECT count(*) FROM provider_services ps WHERE ps.provider_id = p.id) AS services
       FROM providers p WHERE email = $1`,
    [demoEmail],
  )) as Record<string, unknown>[]

  console.log('\nDATABASE')
  console.log(`  status            ${state.status}`)
  console.log(`  onboarding_step   ${state.onboarding_step}`)
  console.log(`  booking_enabled   ${state.booking_enabled}   <- still false, by design`)
  console.log(`  director          ${state.medical_director_type}`)
  console.log(`  services          ${state.services}`)

  console.log('\nADMIN — the invite is now spent')
  await admin.goto(`${BASE}/app/admin/tools`)
  await admin.waitForLoadState('networkidle')
  await capture(admin, 'invite accepted', 'The invite is spent, so the same link cannot mint a second account.')

  writeContactSheet()

  await browser.close()

  // The demo provider is a throwaway. Cleaned up here rather than left to accumulate.
  await query.query(
    `DELETE FROM sessions WHERE provider_id IN (SELECT id FROM providers WHERE email = $1)`,
    [demoEmail],
  )
  await query.query(
    `DELETE FROM provider_services WHERE provider_id IN (SELECT id FROM providers WHERE email = $1)`,
    [demoEmail],
  )
  await query.query(`DELETE FROM providers WHERE email = $1`, [demoEmail])
  await query.query(`DELETE FROM invite_links WHERE email = $1`, [demoEmail])
  console.log('\nDemo provider removed. Screenshots in demo/')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
