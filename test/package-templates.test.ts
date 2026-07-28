import { describe, expect, it } from 'vitest'

import { validateTemplate, type TemplateLineInput } from '@/lib/validate/package-template'

// Building a package.
//
// A template is a blueprint: `client_package_items` are snapshotted at purchase, so editing one
// never rewrites a package somebody already bought. What matters is that a template cannot be
// created in a state that makes no sense, because the numbers on it become the numbers a client
// pays and the per-session value the ledger records on every redemption.

const SERVICE_A = '11111111-1111-1111-1111-111111111111'
const SERVICE_B = '22222222-2222-2222-2222-222222222222'
const NOT_MINE = '33333333-3333-3333-3333-333333333333'

const offered = new Set([SERVICE_A, SERVICE_B])

const line = (serviceId: string, quantity: number, perSessionValue: number): TemplateLineInput => ({
  serviceId,
  quantity,
  perSessionValue,
})

/** Three sessions at $200 = $600. */
const VALID = [line(SERVICE_A, 3, 200)]

describe('validateTemplate', () => {
  it('accepts a package whose lines add up', () => {
    expect(validateTemplate('Carbon 3-pack', 600, VALID, offered)).toBeNull()
  })

  it('accepts several services adding to the total', () => {
    const lines = [line(SERVICE_A, 2, 200), line(SERVICE_B, 1, 150)]
    expect(validateTemplate('Mixed', 550, lines, offered)).toBeNull()
  })

  it('needs a name', () => {
    expect(validateTemplate('   ', 600, VALID, offered)).toMatch(/give the package a name/i)
  })

  it('needs a price above zero', () => {
    // A free package is not a package, and zero would divide badly everywhere downstream.
    expect(validateTemplate('X', 0, VALID, offered)).toMatch(/more than zero/i)
    expect(validateTemplate('X', -100, VALID, offered)).toMatch(/more than zero/i)
    expect(validateTemplate('X', Number.NaN, VALID, offered)).toMatch(/more than zero/i)
  })

  it('needs at least one service', () => {
    expect(validateTemplate('X', 600, [], offered)).toMatch(/at least one service/i)
  })

  it('refuses the same service twice', () => {
    // Quantity expresses multiples. Two lines for one service would make the redemption path
    // ambiguous about which line a session comes off.
    const lines = [line(SERVICE_A, 1, 300), line(SERVICE_A, 1, 300)]
    expect(validateTemplate('X', 600, lines, offered)).toMatch(/only appear once/i)
  })

  it('refuses a service the provider does not offer', () => {
    // Otherwise a package could be sold containing something nobody can perform.
    const lines = [line(NOT_MINE, 3, 200)]
    expect(validateTemplate('X', 600, lines, offered)).toMatch(/currently offer/i)
  })

  it('needs a whole quantity of at least one', () => {
    expect(validateTemplate('X', 600, [line(SERVICE_A, 0, 200)], offered)).toMatch(/at least 1/i)
    expect(validateTemplate('X', 600, [line(SERVICE_A, -1, 200)], offered)).toMatch(/at least 1/i)
    // Half a session is not a thing that can be redeemed.
    expect(validateTemplate('X', 600, [line(SERVICE_A, 1.5, 400)], offered)).toMatch(/at least 1/i)
  })

  it('needs a per-session value above zero', () => {
    expect(validateTemplate('X', 600, [line(SERVICE_A, 3, 0)], offered)).toMatch(/above zero/i)
  })

  it('refuses lines that do not add up to the total', () => {
    // The one that matters. 3 x $200 is $600, so a $500 package would sell each session for
    // less than the ledger records against it on redemption.
    const problem = validateTemplate('X', 500, VALID, offered)
    expect(problem).toMatch(/add up to 600\.00/)
    expect(problem).toMatch(/100\.00 off/)
  })

  it('reports the shortfall in the right direction', () => {
    // Lines under the total: the client pays more than the sessions are worth.
    const problem = validateTemplate('X', 700, VALID, offered)
    expect(problem).toMatch(/-100\.00 off/)
  })

  it('compares in cents, not floating-point dollars', () => {
    // 3 x 33.33 = 99.99, and 0.1 + 0.2 arithmetic would make this either pass or fail by luck.
    expect(validateTemplate('X', 99.99, [line(SERVICE_A, 3, 33.33)], offered)).toBeNull()
    expect(validateTemplate('X', 100, [line(SERVICE_A, 3, 33.33)], offered)).toMatch(/off/)
  })

  it('handles a single penny cleanly', () => {
    expect(validateTemplate('X', 0.01, [line(SERVICE_A, 1, 0.01)], offered)).toBeNull()
  })
})
