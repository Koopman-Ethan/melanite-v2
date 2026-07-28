import { chromium } from '@playwright/test'
import { readFileSync } from 'node:fs'

import '../envConfig'

// Opens the app as a real provider and leaves the window up, so a screen can be looked at
// rather than described. Uses the saved e2e provider session, so no password is typed.
//
//   npx tsx --tsconfig scripts/tsconfig.json scripts/view-as-provider.ts /app/membership 30

const path = process.argv[2] ?? '/app/membership'
const minutes = Number(process.argv[3] ?? 20)
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3113'

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: false })
  const context = await browser.newContext({ viewport: { width: 1400, height: 950 } })
  await context.addCookies(JSON.parse(readFileSync('e2e/.auth/provider.json', 'utf8')).cookies)

  const page = await context.newPage()
  await page.goto(BASE + path)
  await page.waitForLoadState('networkidle')

  const who = await page
    .locator('nav')
    .last()
    .innerText()
    .catch(() => '')
  console.log(`Open at ${path} as ${who.split('\n').slice(-3, -2).join('') || 'the seeded provider'}`)
  console.log(`Window stays up for ${minutes} minutes. Click around freely.`)

  await new Promise((r) => setTimeout(r, minutes * 60_000))
  await browser.close()
}

main().catch((e) => {
  console.error(String(e).slice(0, 300))
  process.exit(1)
})
