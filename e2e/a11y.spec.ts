import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

// Automated WCAG checks on every page a real person reaches.
//
// axe finds roughly a third of accessibility problems — the mechanical ones: missing names,
// broken ARIA, unreadable contrast, bad heading order. It cannot tell you whether a flow makes
// sense to someone who cannot see it. That is what the keyboard tests below and a manual screen
// reader pass are for. Treating a clean axe run as "accessible" is the standard mistake.
//
// Runs on phone and desktop viewports. Layout changes at breakpoints, and so do the problems:
// a control that is reachable at 1440px can be off-screen or overlapped at 390px.

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']

async function scan(page: Page) {
  return new AxeBuilder({ page }).withTags(TAGS).analyze()
}

/** Fails with the actual rule and element, not just a count — a bare "3 violations" tells you
 *  nothing about what to fix. */
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

/** Pages reachable with no session. These matter most: a client following a payment link has
 *  no account, no training, and no way to ask for help. */
const PUBLIC_PAGES = [
  { path: '/login', name: 'sign in' },
  { path: '/forgot-password', name: 'forgot password' },
  { path: '/training', name: 'training enrolment' },
  { path: '/pay/does-not-exist', name: 'payment link — not found' },
]

for (const { path, name } of PUBLIC_PAGES) {
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

test('sign in is fully operable from the keyboard', async ({ page }, testInfo) => {
  // Touch devices have no Tab key; this is a desktop concern by nature.
  test.skip(testInfo.project.name === 'phone', 'keyboard navigation is a desktop concern')

  await page.goto('/login')

  // Tab should reach email, password, then submit — in that order, with nothing invisible in
  // between and no trap.
  await page.keyboard.press('Tab')
  await expect(page.getByLabel('Email')).toBeFocused()

  await page.keyboard.press('Tab')
  await expect(page.getByLabel('Password')).toBeFocused()

  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeFocused()
})

test('the focused control is visibly marked', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'focus rings are a keyboard concern')

  await page.goto('/login')
  await page.keyboard.press('Tab')

  // Asserting the outline is actually painted, not merely that a rule exists somewhere. A
  // focus style that a reset quietly removed looks identical in the source.
  const outline = await page
    .getByLabel('Email')
    .evaluate((el) => getComputedStyle(el).outlineWidth)

  expect(parseFloat(outline)).toBeGreaterThan(0)
})

test('nothing overflows the viewport horizontally', async ({ page }) => {
  await page.goto('/training')
  await page.waitForLoadState('load')

  // Horizontal scrolling on a phone is the most common responsive failure and the most
  // annoying: it makes the whole page drift sideways under your thumb.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )

  expect(overflow, 'page scrolls sideways').toBeLessThanOrEqual(1)
})
