import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { APP_DESTINATIONS, PROTECTED_ROOTS, safeNextPath } from '@/lib/auth/next-path'

// Where somebody is sent after signing in.
//
// The login action used to check only that `next` was relative. That stops an open redirect and
// nothing else: a relative path to a page that does not exist passes, and the person lands on a
// 404 the instant after a successful sign-in.
//
// That is not hypothetical. A provider followed an old bookmark to v1's `/app/login` — a path
// v2 does not have — signed in correctly, was redirected there, saw a bare white 404, and
// reported that she could not log in. She was already logged in.

describe('the open-redirect guards still hold', () => {
  it('refuses anything that could leave the site', () => {
    for (const hostile of [
      'https://evil.example.com',
      '//evil.example.com',
      '/\\evil.example.com',
      '/app\\..\\..',
      'javascript:alert(1)',
      'app/dashboard',
    ]) {
      expect(safeNextPath(hostile), `${hostile} was accepted`).toBe('/app')
    }
  })

  it('falls back when there is nothing to go on', () => {
    expect(safeNextPath(null)).toBe('/app')
    expect(safeNextPath(undefined)).toBe('/app')
    expect(safeNextPath('')).toBe('/app')
    expect(safeNextPath('   ')).toBe('/app')
  })
})

describe('a path that does not exist', () => {
  it('sends the v1 bookmark that caused this to the dashboard', () => {
    // The actual failure. Relative, harmless, and not a page.
    expect(safeNextPath('/app/login')).toBe('/app')
  })

  it('handles the other v1 paths Webflow still forwards', () => {
    // `/app/(.*)` on the marketing site forwards every old app URL. v2 renamed some of them.
    expect(safeNextPath('/app/daily-room-rental')).toBe('/app')
    expect(safeNextPath('/app/medical-director')).toBe('/app')
    expect(safeNextPath('/app/onboard')).toBe('/app')
    expect(safeNextPath('/app/anything-invented')).toBe('/app')
  })
})

describe('a path that does exist', () => {
  it('returns somebody to where they were going', () => {
    expect(safeNextPath('/app/book')).toBe('/app/book')
    expect(safeNextPath('/app/appointments')).toBe('/app/appointments')
    expect(safeNextPath('/app/admin/tools')).toBe('/app/admin/tools')
  })

  it('accepts a dynamic route', () => {
    expect(safeNextPath('/app/admin/training/abc-123')).toBe('/app/admin/training/abc-123')
    // The prefix alone is a real page and is listed; the bare prefix with a trailing slash is
    // the same page, not a course.
    expect(safeNextPath('/app/admin/training/')).toBe('/app/admin/training')
  })

  it('returns somebody to the onboarding step they were on', () => {
    // The regression the first version of this file shipped: `proxy.ts` protects `/onboarding`
    // as well as `/app`, so a provider signing in halfway through setup arrives with
    // `next=/onboarding/license` — and was sent to the dashboard, which is a page they are not
    // allowed to open yet.
    expect(safeNextPath('/onboarding/license')).toBe('/onboarding/license')
    expect(safeNextPath('/onboarding/stripe')).toBe('/onboarding/stripe')
  })

  it('tolerates the shapes a real URL arrives in', () => {
    expect(safeNextPath('/app/book?service=ipl')).toBe('/app/book')
    expect(safeNextPath('/app/book#top')).toBe('/app/book')
    expect(safeNextPath('/app/book/')).toBe('/app/book')
  })
})

describe('the destination list cannot rot', () => {
  // The failure mode this guards: somebody adds a page under app/app/, nobody adds it here, and
  // that page silently stops being a place anybody can be returned to. It would never throw —
  // people would just quietly land on the dashboard instead, and nobody would connect the two.
  it('lists every real page under every protected root', () => {
    const walk = (dir: string, prefix: string): string[] => {
      const found: string[] = []
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (entry === 'page.tsx') found.push(prefix || '/app')
        else if (statSync(full).isDirectory() && !entry.startsWith('_')) {
          // Dynamic segments are covered by DYNAMIC_PREFIXES, not by an exact entry.
          if (entry.startsWith('[')) continue
          found.push(...walk(full, `${prefix}/${entry}`))
        }
      }
      return found
    }

    // Driven by PROTECTED_ROOTS, not by a hardcoded '/app'. Scoping this test to one root is
    // exactly how the onboarding gap got through.
    const routes = PROTECTED_ROOTS.flatMap((prefix) =>
      walk(join(process.cwd(), 'app', ...prefix.slice(1).split('/')), prefix),
    ).sort()
    const missing = routes.filter((r) => !APP_DESTINATIONS.includes(r))

    expect(
      missing,
      `these pages exist but nobody can be returned to them after signing in: ${missing.join(', ')}`,
    ).toEqual([])
  })

  it('does not list pages that no longer exist', () => {
    const exists = (route: string) => {
      try {
        statSync(join(process.cwd(), 'app', ...route.slice(1).split('/'), 'page.tsx'))
        return true
      } catch {
        return false
      }
    }

    const stale = APP_DESTINATIONS.filter((r) => !exists(r))
    expect(stale, `listed but deleted: ${stale.join(', ')}`).toEqual([])
  })
})
