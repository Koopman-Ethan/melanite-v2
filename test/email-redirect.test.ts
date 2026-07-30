import { afterEach, describe, expect, it } from 'vitest'

import { resolveRecipient } from '@/lib/email'

// Who actually receives a message sent from a non-production environment.
//
// Resend has no test mode: one account, one set of credentials, and every address is a real
// inbox. appdev runs on a copy of production data, so a booking confirmation triggered by a
// test run would email a real client of Melanite's about an appointment that does not exist.
//
// This is the only thing standing between a test run and that, which is why it is tested at all
// — it is invisible on a normal day and carries the whole weight of a bad one.

const ORIGINAL_ENV = process.env.MELANITE_ENV
const ORIGINAL_REDIRECT = process.env.EMAIL_REDIRECT_TO

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.MELANITE_ENV
  else process.env.MELANITE_ENV = ORIGINAL_ENV
  if (ORIGINAL_REDIRECT === undefined) delete process.env.EMAIL_REDIRECT_TO
  else process.env.EMAIL_REDIRECT_TO = ORIGINAL_REDIRECT
})

describe('production', () => {
  it('sends to the person it is addressed to, with the subject untouched', () => {
    process.env.MELANITE_ENV = 'prod'
    process.env.EMAIL_REDIRECT_TO = 'someone@example.com'

    const route = resolveRecipient('client@realdomain.com')
    expect(route.to).toBe('client@realdomain.com')
    expect(route.subject('Your appointment is confirmed')).toBe('Your appointment is confirmed')
  })

  it('ignores a redirect address left lying around', () => {
    // A stale EMAIL_REDIRECT_TO in production must not silently divert real client mail to a
    // developer. Production is the one environment where the intended recipient always wins.
    process.env.MELANITE_ENV = 'prod'
    process.env.EMAIL_REDIRECT_TO = 'dev@example.com'
    expect(resolveRecipient('client@realdomain.com').to).toBe('client@realdomain.com')
  })
})

describe('everywhere else', () => {
  it('redirects, and names the intended recipient in the subject', () => {
    process.env.MELANITE_ENV = 'dev'
    process.env.EMAIL_REDIRECT_TO = 'me@mine.com'

    const route = resolveRecipient('a.real.client@gmail.com')
    expect(route.to).toBe('me@mine.com')
    // Without this a redirected message looks exactly like one that arrived at its destination,
    // and a test run reads as proof the client was told.
    expect(route.subject('Your appointment is confirmed')).toBe(
      '[to: a.real.client@gmail.com] Your appointment is confirmed',
    )
  })

  it('REFUSES to send when no redirect address is configured', () => {
    // The important half. Falling back to the intended recipient would mean a fresh preview
    // environment — the one most likely to be pointed at real data by accident — mails real
    // clients, and nothing about the setup would look wrong.
    process.env.MELANITE_ENV = 'dev'
    delete process.env.EMAIL_REDIRECT_TO
    const route = resolveRecipient('a.real.client@gmail.com')
    expect(route.to).toBeNull()
    expect(route.note).toMatch(/EMAIL_REDIRECT_TO/)
  })

  it('treats an unset environment as not production', () => {
    // Same reasoning as the destructive-script guard: absent is not permission. A machine with
    // no MELANITE_ENV is not thereby allowed to email clients.
    delete process.env.MELANITE_ENV
    process.env.EMAIL_REDIRECT_TO = 'me@mine.com'
    expect(resolveRecipient('client@realdomain.com').to).toBe('me@mine.com')
  })

  it('treats an unrecognised environment as not production', () => {
    for (const value of ['production', 'staging', 'PROD ', 'live']) {
      process.env.MELANITE_ENV = value
      process.env.EMAIL_REDIRECT_TO = 'me@mine.com'
      const route = resolveRecipient('client@realdomain.com')
      // `PROD ` with whitespace IS production — trimmed and lowercased, same as the env guard.
      const expected = value.trim().toLowerCase() === 'prod' ? 'client@realdomain.com' : 'me@mine.com'
      expect(route.to, `MELANITE_ENV=${JSON.stringify(value)}`).toBe(expected)
    }
  })
})
