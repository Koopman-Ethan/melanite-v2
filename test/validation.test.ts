import { describe, expect, it } from 'vitest'

import {
  amountError,
  emailError,
  formatPhone,
  isValidEmail,
  isValidPhone,
  nameError,
  phoneDigits,
  phoneError,
} from '@/lib/validation'

// What the forms and the server actions BOTH enforce.
//
// The rule lived in two places before this: a private regex in `app/training/actions.ts`, and
// `type="email"` on the inputs. Neither covered the app — `type="tel"` has never validated
// anything in any browser, and `type="email"` only fires on a native form submit, which several
// of these forms do not do. So a phone field accepted "hello" and a receipt could be addressed
// to nothing at all.

describe('email', () => {
  it('requires an @', () => {
    expect(isValidEmail('keoni.example.com')).toBe(false)
    // The most common mistake by a distance, so it gets its own message.
    expect(emailError('keoni.example.com')).toMatch(/needs an @/)
  })

  it('requires a domain that could exist', () => {
    expect(isValidEmail('keoni@')).toBe(false)
    expect(isValidEmail('keoni@localhost')).toBe(false)
    expect(isValidEmail('keoni@example')).toBe(false)
    expect(isValidEmail('keoni@example.c')).toBe(false)
  })

  it('rejects the things copy-paste actually produces', () => {
    expect(isValidEmail('keoni@example.com,')).toBe(false)
    expect(isValidEmail('keoni@example.com;')).toBe(false)
    expect(isValidEmail('keoni @example.com')).toBe(false)
    expect(isValidEmail('<keoni@example.com>')).toBe(false)
  })

  it('accepts addresses real people have', () => {
    for (const address of [
      'keoni@example.com',
      'ethan.koopman@gmail.com',
      'first+tag@example.co.uk',
      "o'brien@example.com",
      'a_b-c@sub.example.org',
      'KEONI@EXAMPLE.COM',
    ]) {
      expect(isValidEmail(address), `${address} was rejected`).toBe(true)
    }
  })

  it('treats blank as missing, not malformed', () => {
    // Two different problems. "That doesn't look like an email" on an empty box is nonsense.
    expect(emailError('')).toMatch(/Enter an email/)
    expect(emailError('', { required: false })).toBeNull()
    expect(emailError('   ', { required: false })).toBeNull()
  })

  it('rejects something longer than an address can be', () => {
    expect(isValidEmail(`${'a'.repeat(250)}@example.com`)).toBe(false)
  })
})

describe('phone', () => {
  it('rejects letters', () => {
    // The thing that prompted all of this.
    expect(isValidPhone('hello')).toBe(false)
    expect(isValidPhone('call me')).toBe(false)
    // Not "enter a phone number" — they clearly entered something, and saying otherwise
    // reads as though the app never saw it.
    expect(phoneError('hello')).toMatch(/doesn’t look like a phone number/)
    expect(phoneError('212')).toMatch(/10 digits/)
    // Optional means "may be blank", never "may be nonsense".
    expect(phoneError('hello', { required: false })).not.toBeNull()
  })

  it('accepts a US number however it was typed', () => {
    for (const typed of [
      '2085550134',
      '(208) 555-0134',
      '208-555-0134',
      '208.555.0134',
      '+1 208 555 0134',
      '1 (208) 555-0134',
    ]) {
      expect(isValidPhone(typed), `${typed} was rejected`).toBe(true)
    }
  })

  it('rejects a number that is the wrong length', () => {
    expect(isValidPhone('208555')).toBe(false)
    expect(isValidPhone('20855501345')).toBe(false)
    // 11 digits are only valid behind a country code of 1.
    expect(isValidPhone('22085550134')).toBe(false)
  })

  it('formats progressively, without fighting the typist', () => {
    // A field that inserts a bracket the person then has to delete is a field people avoid.
    expect(formatPhone('')).toBe('')
    expect(formatPhone('2')).toBe('(2')
    expect(formatPhone('208')).toBe('(208')
    expect(formatPhone('2085')).toBe('(208) 5')
    expect(formatPhone('208555')).toBe('(208) 555')
    expect(formatPhone('2085550134')).toBe('(208) 555-0134')
  })

  it('drops a pasted country code rather than refusing it', () => {
    // People paste `+1 …` constantly. Refusing it teaches them to distrust the field.
    expect(formatPhone('+1 208 555 0134')).toBe('(208) 555-0134')
    expect(formatPhone('12085550134')).toBe('(208) 555-0134')
  })

  it('discards letters instead of complaining about them', () => {
    expect(formatPhone('abc208def555ghi0134')).toBe('(208) 555-0134')
    expect(formatPhone('hello')).toBe('')
  })

  it('stops at ten digits', () => {
    expect(formatPhone('20855501349999')).toBe('(208) 555-0134')
  })

  it('keeps only the digits when asked', () => {
    expect(phoneDigits('(208) 555-0134')).toBe('2085550134')
  })

  it('treats blank as missing, not malformed', () => {
    expect(phoneError('')).toMatch(/Enter a phone/)
    expect(phoneError('', { required: false })).toBeNull()
  })
})

describe('names', () => {
  it('does not tell anybody their own name is invalid', () => {
    // Every "letters only" rule ever written has done this to somebody. Length only.
    for (const name of ["O'Brien", 'Anne-Marie', 'van der Berg', 'Nguyễn', '李', 'Ó Súilleabháin']) {
      expect(nameError(name, 'a name'), `${name} was rejected`).toBeNull()
    }
  })

  it('still requires something', () => {
    expect(nameError('', 'a first name')).toMatch(/Enter a first name/)
    expect(nameError('   ', 'a first name')).toMatch(/Enter a first name/)
  })
})

describe('amounts', () => {
  it('rejects what type="number" happily accepts', () => {
    // All three of these reach a server action as a perfectly valid Number, and none is a price.
    expect(amountError('-50')).toMatch(/can’t be negative/)
    expect(amountError('1e9')).toMatch(/too large/)
    expect(amountError('0.001')).toMatch(/two decimal places/)
  })

  it('accepts money', () => {
    expect(amountError('0')).toBeNull()
    expect(amountError('200')).toBeNull()
    expect(amountError('1234.56')).toBeNull()
  })

  it('rejects text', () => {
    expect(amountError('free')).toMatch(/as a number/)
  })
})
