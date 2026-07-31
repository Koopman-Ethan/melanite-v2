import { defineConfig, devices } from '@playwright/test'

// Credentials for the signed-in specs live in .env.local alongside everything else, and are
// never committed. Loaded through the project's own envConfig so the rules match what Next
// itself applies — one loader, not two that can disagree about precedence.
import './envConfig'

// Playwright, used first for accessibility and later for end-to-end journeys.
//
// Runs against the already-running dev server on 3113 rather than starting its own. That is
// deliberate for now: the suite needs a real database with real rows, and spinning up an
// isolated stack per run is a bigger problem than this phase is solving.
//
// Uses the system Chrome (`channel: 'chrome'`) rather than downloading a Chromium build —
// faster to set up, and it is the browser providers actually use.

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  // Capped, because these specs share ONE database and ONE dev server. At full parallelism the
  // journey specs contend over the same rows — a redemption spec found "the session was not
  // consumed" because something else was consuming it — and pages time out waiting on a server
  // serving eight tabs at once. Both look like product bugs and are not.
  //
  // vitest already sets `fileParallelism: false` for the same reason and says so; this is the
  // browser half of that decision, which had been left at the default. Two workers runs the
  // suite in about a minute, which is not the constraint worth optimising.
  workers: 2,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3113',
    trace: 'retain-on-failure',
  },
  projects: [
    // Signs in once per role; the page specs reuse the saved session.
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
      use: { channel: 'chrome' },
      teardown: 'cleanup',
    },
    { name: 'cleanup', testMatch: /cleanup\.teardown\.ts/, use: { channel: 'chrome' } },
    {
      // The primary target. A provider stands in a treatment room holding a phone, so this is
      // the case that has to work — not the desktop one that happens to get tested first.
      //
      // Viewport given explicitly rather than via devices['iPhone 14']: that profile is WebKit,
      // and pairing it with the Chrome channel fails outright. iPhone 14 dimensions on Chromium
      // is the honest description of what this actually tests.
      name: 'phone',
      use: {
        channel: 'chrome',
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
      dependencies: ['setup'],
    },
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], channel: 'chrome' },
      dependencies: ['setup'],
    },
  ],
})
