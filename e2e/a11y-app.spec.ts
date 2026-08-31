import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

// The signed-in surfaces. This is where most of the app lives — calendars, dense tables,
// multi-step forms — and where accessibility problems are far likelier than on a login page
// with two fields.

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']

async function scan(page: Page) {
  return new AxeBuilder({ page }).withTags(TAGS).analyze()
}

function report(results: Awaited<ReturnType<typeof scan>>) {
  return results.violations
    .map((v) => {
      const where = v.nodes
        .slice(0, 3)
        .map((n) => `      ${n.target.join(' ')}`)
        .join('\n')
      return `  [${v.impact}] ${v.id} — ${v.help}\n${where}`
    })
    .join('\n')
}

const PROVIDER_PAGES = [
  { path: '/app/dashboard', name: 'dashboard' },
  { path: '/app/book', name: 'book laser time' },
  { path: '/app/appointments', name: 'appointments' },
  { path: '/app/earnings', name: 'earnings' },
  { path: '/app/packages', name: 'packages' },
  { path: '/app/room-rental', name: 'room rental' },
  { path: '/app/services', name: 'my services' },
  { path: '/app/membership', name: 'membership' },
  { path: '/app/account', name: 'account' },
]

const ADMIN_PAGES = [
  { path: '/app/admin', name: 'admin home' },
  { path: '/app/admin/calendar', name: 'admin calendar' },
  { path: '/app/admin/equipment', name: 'admin equipment' },
  { path: '/app/admin/queue', name: 'admin queue' },
  { path: '/app/admin/revenue', name: 'admin revenue' },
  { path: '/app/admin/tools', name: 'admin tools' },
  { path: '/app/admin/training', name: 'admin training' },
]

test.describe('provider pages', () => {
  test.use({ storageState: 'e2e/.auth/provider.json' })

  for (const { path, name } of PROVIDER_PAGES) {
    test(`${name} has no axe violations`, async ({ page }) => {
      await page.goto(path)
      // `load`, not `networkidle`. The training page mounts Stripe.js, which holds connections
    // open, so the network never goes idle and the wait times out — on the phone project first,
    // because it is slower. Playwright discourages networkidle for exactly this reason. `load`
    // is deterministic and is all axe needs: the DOM is rendered and styles are applied.
    await page.waitForLoadState('load')

      const results = await scan(page)
      expect(results.violations, `\n${report(results)}\n`).toEqual([])
    })
  }

  test('no page scrolls sideways on a phone', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'phone', 'phone-only check')

    for (const { path, name } of PROVIDER_PAGES) {
      await page.goto(path)
      await page.waitForLoadState('load')

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      expect(overflow, `${name} scrolls sideways`).toBeLessThanOrEqual(1)
    }
  })
})

test.describe('admin pages', () => {
  test.use({ storageState: 'e2e/.auth/admin.json' })

  for (const { path, name } of ADMIN_PAGES) {
    test(`${name} has no axe violations`, async ({ page }) => {
      await page.goto(path)
      await page.waitForLoadState('load')

      const results = await scan(page)
      expect(results.violations, `\n${report(results)}\n`).toEqual([])
    })
  }

  test('no admin page scrolls sideways on a phone', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'phone', 'phone-only check')

    for (const { path, name } of ADMIN_PAGES) {
      await page.goto(path)
      await page.waitForLoadState('load')

      // Wide tables are allowed to scroll inside their own container; the PAGE must not.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      expect(overflow, `${name} scrolls sideways`).toBeLessThanOrEqual(1)
    }
  })
})
