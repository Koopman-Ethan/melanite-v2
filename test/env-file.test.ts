import { describe, expect, it } from 'vitest'

import { parseEnvFile } from '@/lib/env-file'

// The file that says which database a migration is about to write to.
//
// It is parsed by hand rather than by dotenv because @next/env only exposes dotenv as a bundled
// implementation detail. That makes these tests the only thing standing between a typo in an
// env file and a value that silently does not take effect — which, for DATABASE_URL on
// migration night, means writing to whatever the previous file said.

describe('parseEnvFile', () => {
  it('reads plain assignments', () => {
    expect(parseEnvFile('MELANITE_ENV=prod\nDATABASE_URL=postgres://x/y')).toEqual({
      MELANITE_ENV: 'prod',
      DATABASE_URL: 'postgres://x/y',
    })
  })

  it('ignores comments and blank lines', () => {
    const text = ['# Melanite — production', '', '  # indented note', 'A=1', '', 'B=2'].join('\n')
    expect(parseEnvFile(text)).toEqual({ A: '1', B: '2' })
  })

  it('strips surrounding quotes but keeps what is inside', () => {
    // A connection string with a password full of punctuation is the normal case, not the
    // exotic one.
    expect(parseEnvFile(`A="p@ss w#rd"\nB='sk_live_123'`)).toEqual({
      A: 'p@ss w#rd',
      B: 'sk_live_123',
    })
  })

  it('keeps = signs inside a value', () => {
    // Postgres URLs end in `?sslmode=require`. Splitting on every `=` would truncate exactly
    // the part that makes the connection work.
    expect(parseEnvFile('DATABASE_URL=postgres://u:p@h/db?sslmode=require&channel=x')).toEqual({
      DATABASE_URL: 'postgres://u:p@h/db?sslmode=require&channel=x',
    })
  })

  it('tolerates whitespace and a leading export', () => {
    expect(parseEnvFile('  export  A = 1 \nB=  2  ')).toEqual({ A: '1', B: '2' })
  })

  it('reads an empty value as empty, not as missing', () => {
    // `STRIPE_EPICUTIS_PRICE_ID=` means "deliberately nothing". Code reading it checks for a
    // non-empty string, so this must not come back as the key being absent.
    expect(parseEnvFile('A=\nB=x')).toEqual({ A: '', B: 'x' })
  })

  it('skips lines it does not understand rather than throwing', () => {
    // A half-typed line should not stop a migration that is otherwise correct.
    expect(parseEnvFile('nonsense\n123=nope\nA=1')).toEqual({ A: '1' })
  })

  it('lets a later line win, as a shell would', () => {
    expect(parseEnvFile('A=1\nA=2')).toEqual({ A: '2' })
  })
})
