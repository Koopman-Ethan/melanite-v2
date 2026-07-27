import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { chromium, type Page } from '@playwright/test'
import { neon } from '@neondatabase/serverless'

import '../envConfig'
import { hashPassword } from '../lib/auth/password'

// A look at the two role-scoped surfaces: what the medical director sees, and the admin tools.
//
// Both run on THROWAWAY accounts created here and deleted at the end — never on a real one.
// The e2e admin credentials are a person's actual login, and signing in as somebody to take
// screenshots is not a thing to do casually.
//
// Pass a number of minutes to leave both windows open afterwards, so the screens can actually
// be looked at rather than flashing past:
//
//   npx tsx --tsconfig scripts/tsconfig.json scripts/demo-roles.ts 20
//
// The throwaway accounts stay alive for that whole window and are deleted when it ends.

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3113'
const SHOTS = join(process.cwd(), 'demo-roles')
const query = neon(process.env.DATABASE_URL!)

const PASSWORD = 'Demo-Roles-Aa1!view'
const stamp = Date.now()
const directorEmail = `zz.onboard.demo.director.${stamp}@example.com`
const adminEmail = `zz.onboard.demo.admin.${stamp}@example.com`
const DEMO_CLIENT = `ZZ DEMO ${stamp}`

/** Minutes to leave the browser open before tearing everything down. */
const HOLD_MINUTES = Number(process.argv[2] ?? 0)

const captured: { file: string; label: string; note: string }[] = []

async function capture(page: Page, label: string, note: string) {
  const file = `${String(captured.length + 1).padStart(2, '0')}-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.jpg`
  await page.screenshot({ path: join(SHOTS, file), type: 'jpeg', quality: 80, fullPage: true })
  captured.push({ file, label, note })
  console.log(`  ${file}`)
}

async function signIn(page: Page, email: string) {
  await page.goto(`${BASE}/login`)
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: /sign in/i }).click()
  // NOT /app — that is a redirect stub with no content, and waiting for it caught a blank page
  // mid-hop. Wait for wherever the role actually lands.
  await page.waitForURL((url) => /\/app\/.+/.test(url.pathname), { timeout: 20_000 })
  await page.waitForLoadState('networkidle')
}

async function makeAccount(email: string, role: string, first: string, last: string) {
  const rows = (await query.query(
    `INSERT INTO providers (email, password_hash, requires_password_reset, first_name, last_name,
                            role, status, onboarding_step, booking_enabled)
     VALUES ($1, $2, false, $3, $4, $5::provider_role, 'active', 6, false)
     RETURNING id`,
    [email, await hashPassword(PASSWORD), first, last, role],
  )) as { id: string }[]
  return rows[0].id
}

/** A couple of appointments and a room rental so the schedule is not an empty state.
 *
 *  Best-effort: the room has an EXCLUDE constraint on overlapping ranges, so a demo row that
 *  collides with a real booking is skipped rather than allowed to fail the run. */
async function seedSchedule() {
  const [ps] = (await query.query(
    `SELECT ps.id, ps.provider_id, ps.duration_mins, ps.price
       FROM provider_services ps
       JOIN providers p ON p.id = ps.provider_id
      WHERE ps.is_active AND p.medical_director_type = 'melanite' AND p.status = 'active'
      LIMIT 1`,
  )) as Record<string, string>[]
  if (!ps) return

  for (const [days, hour, area] of [
    [2, 10, 'Underarms'],
    [4, 14, 'Full legs'],
  ] as const) {
    await query
      .query(
        `INSERT INTO bookings (provider_id, provider_service_id, client_name, original_price,
                               price, payment_source, duration_mins, start_time, end_time, status)
         VALUES ($1, $2, $3, $4, $4, 'stripe', $5,
                 date_trunc('day', now()) + ($6 || ' days')::interval + ($7 || ' hours')::interval,
                 date_trunc('day', now()) + ($6 || ' days')::interval + ($7 || ' hours')::interval
                   + ($5 || ' minutes')::interval,
                 'upcoming')`,
        [ps.provider_id, ps.id, `${DEMO_CLIENT} ${area}`, ps.price, ps.duration_mins, String(days), String(hour)],
      )
      .catch((e) => console.log(`  (demo booking skipped: ${String(e).slice(0, 140)})`))
  }

  await query
    .query(
      `INSERT INTO room_bookings (provider_id, rental_date, slot_type, price, status, start_at, end_at)
       VALUES ($1, (current_date + 3), 'full', '100.00', 'confirmed',
               date_trunc('day', now()) + interval '3 days' + interval '8 hours',
               date_trunc('day', now()) + interval '3 days' + interval '20 hours')`,
      [ps.provider_id],
    )
    .catch((e) => console.log(`  (demo rental skipped: ${String(e).slice(0, 140)})`))
}

function writeContactSheet() {
  const cards = captured
    .map(
      (c) => `    <figure>
      <img src="${c.file}" alt="${c.label}" loading="lazy">
      <figcaption><b>${c.label}</b><span>${c.note}</span></figcaption>
    </figure>`,
    )
    .join('\n')

  writeFileSync(
    join(SHOTS, 'index.html'),
    `<!doctype html><meta charset="utf-8"><title>Melanite role views</title>
<style>
  :root { color-scheme: dark }
  body { margin:0; padding:2.5rem 1.5rem; background:#0f0f0f; color:#ddd;
         font:16px/1.55 system-ui, sans-serif }
  header { max-width:1100px; margin:0 auto 2.5rem }
  h1 { margin:0 0 .5rem; font-size:1.6rem }
  header p { margin:0; color:#a8a8a8; max-width:64ch }
  main { max-width:1100px; margin:0 auto; display:grid; gap:2.5rem }
  figure { margin:0 }
  img { width:100%; border:1px solid #2a2a2a; border-radius:10px; display:block }
  figcaption { margin-top:.65rem; font-size:.85rem; color:#a8a8a8 }
  figcaption b { color:#b8965a; font-weight:600; text-transform:capitalize }
  figcaption span { display:block; margin-top:.2rem }
</style>
<header>
  <h1>Role-scoped views</h1>
  <p>The medical director's oversight page and the new admin tools, captured on throwaway
     accounts created and deleted by the script — no real login was used.</p>
</header>
<main>
${cards}
</main>
`,
    'utf-8',
  )
  console.log('\n  demo-roles/index.html')
}

async function main() {
  mkdirSync(SHOTS, { recursive: true })

  const directorId = await makeAccount(directorEmail, 'medical_director', 'Brandon', 'Demo')
  const adminId = await makeAccount(adminEmail, 'platform_owner', 'Demo', 'Owner')
  await seedSchedule()

  const browser = await chromium.launch({ channel: 'chrome', headless: false, slowMo: 300 })

  // --- Medical director ---------------------------------------------------------------------
  console.log('\nMEDICAL DIRECTOR')
  const dirCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const dir = await dirCtx.newPage()
  await signIn(dir, directorEmail)
  console.log(`  landed on ${new URL(dir.url()).pathname}`)
  await dir.waitForLoadState('networkidle')
  await capture(
    dir,
    'oversight',
    'Signing in lands here, not on a redirect loop. Who he covers, whether their licences are current, what each is credentialed to perform, and the next 14 days of appointments and room rentals interleaved. No money anywhere.',
  )

  // The sidebar is the clearest proof of the scoping.
  await capture(
    dir,
    'director sidebar',
    'Two items: Oversight and Account. No Revenue, no Tools, no Providers — and none of the provider surfaces either.',
  )

  // --- Admin ----------------------------------------------------------------------------------
  console.log('\nADMIN')
  const adminCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const admin = await adminCtx.newPage()
  await signIn(admin, adminEmail)
  await admin.goto(`${BASE}/app/admin`)
  await admin.waitForLoadState('networkidle')
  await capture(
    admin,
    'admin home with licence panel',
    'The new panel lists only licences needing action, most urgent first, with a missing date sorted above an expired one. Previously nothing anywhere told Melanite a licence was about to lapse.',
  )

  await admin.goto(`${BASE}/app/admin/providers`)
  await admin.waitForLoadState('networkidle')
  await capture(
    admin,
    'providers roster',
    'The manual database edit, as a screen. Context sits above the controls — licence, medical director, payouts — so enabling booking is a judgement rather than a blind switch.',
  )

  await admin.goto(`${BASE}/app/admin/tools`)
  await admin.waitForLoadState('networkidle')
  await capture(
    admin,
    'invite tool',
    'Show link recovers an invite URL after a reload, and Resend re-sends the same token rather than minting a new one that would silently kill the first.',
  )

  writeContactSheet()

  if (HOLD_MINUTES > 0) {
    console.log(`
Both windows are open — the director on the left, the admin on the right.`)
    console.log(`Click around. Everything is deleted in ${HOLD_MINUTES} minutes.`)
    console.log(`Sign-in for either window, if you get logged out:`)
    console.log(`  director  ${directorEmail}`)
    console.log(`  admin     ${adminEmail}`)
    console.log(`  password  ${PASSWORD}`)
    await new Promise((resolve) => setTimeout(resolve, HOLD_MINUTES * 60_000))
  }

  await browser.close()

  // --- Cleanup -------------------------------------------------------------------------------
  console.log('\nCleaning up')
  await query.query(`DELETE FROM room_bookings WHERE provider_id IN (
      SELECT provider_id FROM provider_services LIMIT 0) OR (rental_date = current_date + 3
      AND status = 'confirmed' AND price = '100.00' AND created_at > now() - interval '10 minutes')`)
  await query.query(`DELETE FROM bookings WHERE client_name LIKE $1`, [`${DEMO_CLIENT}%`])
  for (const id of [directorId, adminId]) {
    await query.query(`DELETE FROM sessions WHERE provider_id = $1`, [id])
    await query.query(`DELETE FROM providers WHERE id = $1`, [id])
  }
  console.log('Demo accounts and rows removed. Screenshots in demo-roles/')
}

main().catch(async (err) => {
  console.error(err)
  process.exit(1)
})
