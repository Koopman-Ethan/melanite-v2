import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  WrongEnvironmentError,
  currentEnv,
  requireEnv,
  requireProductionOptIn,
} from '@/lib/env-guard'

// The guard on destructive scripts.
//
// It is tested because it is the kind of code that is never exercised on a normal day and then
// carries the whole weight of a bad one. Nobody notices a broken guard until the run it was
// supposed to stop.
//
// It also replaces two guards that looked real and were not: a check for "prod" in the
// connection string (a Neon URL is `ep-old-paper-a6ligt30...`, so it matched nothing ever), and
// the temptation to infer the environment from the git branch — which failed for me in the most
// direct way possible, a full day spent pushing to a branch I was not on.

const ORIGINAL = process.env.MELANITE_ENV
const ORIGINAL_ARGV = process.argv

beforeEach(() => {
  process.argv = ['node', 'script']
})

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.MELANITE_ENV
  else process.env.MELANITE_ENV = ORIGINAL
  process.argv = ORIGINAL_ARGV
})

describe('currentEnv', () => {
  it('reads dev and prod', () => {
    process.env.MELANITE_ENV = 'dev'
    expect(currentEnv()).toBe('dev')
    process.env.MELANITE_ENV = 'prod'
    expect(currentEnv()).toBe('prod')
  })

  it('tolerates whitespace and case', () => {
    // Env files get edited by hand, in a hurry, at night.
    process.env.MELANITE_ENV = '  PROD  '
    expect(currentEnv()).toBe('prod')
  })

  it('treats anything else as unset', () => {
    // `staging`, `production`, `Dev1` — none of these are the two words this understands, and
    // guessing at intent is how a guard becomes decoration.
    for (const value of ['', 'staging', 'production', 'development', 'yes']) {
      process.env.MELANITE_ENV = value
      expect(currentEnv()).toBeNull()
    }
  })
})

describe('requireEnv', () => {
  it('allows what it is told to allow', () => {
    process.env.MELANITE_ENV = 'dev'
    expect(requireEnv(['dev'], 'do a thing')).toBe('dev')
  })

  it('REFUSES when unset, rather than assuming dev', () => {
    // The important half. Treating "unset" as safe would exempt every environment configured
    // before this existed — including whatever gets thrown together on migration night.
    delete process.env.MELANITE_ENV
    expect(() => requireEnv(['dev'], 'scrub')).toThrow(WrongEnvironmentError)
    expect(() => requireEnv(['dev'], 'scrub')).toThrow(/not set/i)
  })

  it('refuses prod for a dev-only action, and says which is which', () => {
    process.env.MELANITE_ENV = 'prod'
    expect(() => requireEnv(['dev'], 'scrub client details')).toThrow(/only allowed in: dev/i)
  })

  it('never leaks the connection string', async () => {
    // The message names the host so an operator can tell environments apart. It must not name
    // the password, because refusals get pasted into chat.
    process.env.MELANITE_ENV = 'prod'
    process.env.DATABASE_URL = 'postgres://someone:hunter2@db.example.com/main?sslmode=require'
    try {
      requireEnv(['dev'], 'scrub')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(String(err)).toContain('db.example.com')
      expect(String(err)).not.toContain('hunter2')
    }
  })
})

describe('requireProductionOptIn', () => {
  it('needs prod AND the flag — either alone is refused', () => {
    process.env.MELANITE_ENV = 'dev'
    process.argv = ['node', 'script', '--i-know-this-is-production']
    expect(() => requireProductionOptIn('load')).toThrow(/only allowed in: prod/i)

    process.env.MELANITE_ENV = 'prod'
    process.argv = ['node', 'script']
    expect(() => requireProductionOptIn('load')).toThrow(/necessary and not sufficient/i)
  })

  it('allows the deliberate case', () => {
    // Two independent statements, because either one alone is something a person can do without
    // noticing: an env file left over from yesterday, or a flag copied out of a runbook.
    process.env.MELANITE_ENV = 'prod'
    process.argv = ['node', 'script', '--i-know-this-is-production']
    expect(() => requireProductionOptIn('load')).not.toThrow()
  })
})
