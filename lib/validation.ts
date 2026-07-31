// Field rules, shared by the form and the server action that receives it.
//
// ONE module for both sides on purpose. The classic failure is a browser that accepts something
// the server then rejects — or worse, the reverse, where a form politely refuses input the
// server would have been happy with. Two copies of a rule diverge the first time one is edited.
//
// None of this is a security boundary. A form can be bypassed entirely; the server action is
// the only thing standing between a caller and the database, which is why every check here is
// called from BOTH places rather than only from the pretty one.
//
// Deliberately hand-rolled rather than pulling in zod. The rules are three fields deep, the
// codebase already hand-rolls its env parser and money handling for the same reason, and a
// schema library would earn its place at ten times this complexity, not at this one.

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

/** Pragmatic, not RFC 5322.
 *
 *  The full grammar permits quoted strings, comments and nested parentheses, and the regex that
 *  implements it is famously several kilobytes long. It would accept `"a b"(c)@[192.168.0.1]`
 *  and reject nothing anybody has ever typed by accident.
 *
 *  What actually goes wrong here is a missing @, a trailing comma, a space in the middle, or
 *  `gmail.con`. The first three are caught; the fourth cannot be caught by any regex, which is
 *  why receipts also get confirmed on screen rather than only being sent. */
const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}$/i

export function isValidEmail(value: string): boolean {
  const trimmed = value.trim()
  // 254 is the RFC 5321 ceiling for a whole address. Anything longer is paste-gone-wrong.
  if (trimmed.length === 0 || trimmed.length > 254) return false
  return EMAIL.test(trimmed)
}

/** The message a person sees. Says what is wrong, not that something is. */
export function emailError(value: string, { required = true } = {}): string | null {
  const trimmed = value.trim()
  if (!trimmed) return required ? 'Enter an email address.' : null
  if (!trimmed.includes('@')) return 'An email address needs an @ — for example, name@example.com.'
  if (!EMAIL.test(trimmed)) return 'That doesn’t look like an email address.'
  if (trimmed.length > 254) return 'That email address is too long.'
  return null
}

// ---------------------------------------------------------------------------
// Phone
// ---------------------------------------------------------------------------

/** Everything that is not a digit. */
const NON_DIGIT = /\D+/g

/** Just the digits, which is the only part that carries meaning.
 *
 *  A US number arrives as `2085550134`, `(208) 555-0134`, `208.555.0134` or `+1 208 555 0134`
 *  depending entirely on who is typing. Comparing or validating the punctuation is comparing
 *  the typist, not the number. */
export function phoneDigits(value: string): string {
  return value.replace(NON_DIGIT, '')
}

/** US ten-digit, optionally with the country code.
 *
 *  Melanite operates in one state and every number in the v1 export is domestic, so this is
 *  deliberately not an international validator — libphonenumber is 200kB to tell us that an
 *  Idaho mobile is an Idaho mobile. If Melanite ever takes an international client, this is the
 *  one function that changes. */
export function isValidPhone(value: string): boolean {
  const digits = phoneDigits(value)
  if (digits.length === 10) return true
  return digits.length === 11 && digits.startsWith('1')
}

export function phoneError(value: string, { required = true } = {}): string | null {
  const trimmed = value.trim()
  const digits = phoneDigits(value)

  // Empty and "hello" are different problems and deserve different sentences. Telling somebody
  // who typed something to "enter a phone number" reads as though the app did not see it.
  //
  // The form filters letters out before they land, so in the browser this only ever fires as
  // the empty case. It matters on the SERVER, where the value arrives unfiltered from whatever
  // sent it — which is the whole reason the rule is called from both sides.
  if (!trimmed) return required ? 'Enter a phone number.' : null
  if (digits.length === 0) return 'That doesn’t look like a phone number.'
  if (digits.length < 10) return 'A phone number needs 10 digits.'
  if (!isValidPhone(value)) return 'That doesn’t look like a US phone number.'
  return null
}

/** `(208) 555-0134`, as somebody types it.
 *
 *  Formats progressively — partial input formats as far as it can and no further, so the field
 *  never fights the person filling it in by inserting a bracket they then have to delete.
 *
 *  A leading 1 is dropped rather than rejected: people paste `+1 208 555 0134` constantly, and
 *  refusing it teaches them to distrust the field. */
export function formatPhone(value: string): string {
  let digits = phoneDigits(value)
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1)
  digits = digits.slice(0, 10)

  if (digits.length === 0) return ''
  if (digits.length <= 3) return `(${digits}`
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
}

// ---------------------------------------------------------------------------
// Names and free text
// ---------------------------------------------------------------------------

/** A person's name.
 *
 *  Length only. NOT a character rule: names legitimately contain apostrophes, hyphens, spaces,
 *  accents and non-Latin scripts, and every "letters only" rule ever written has told somebody
 *  their own name is invalid. The check that matters is that something was typed. */
export function nameError(value: string, label: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return `Enter ${label}.`
  if (trimmed.length > 100) return `${label[0].toUpperCase()}${label.slice(1)} is too long.`
  return null
}

// ---------------------------------------------------------------------------
// Money typed by a person
// ---------------------------------------------------------------------------

/** A price or amount entered in a form.
 *
 *  `type="number"` alone permits `-50`, `1e9` and `0.001`, all of which reach the server as a
 *  perfectly valid Number and none of which is a price. Money is integer cents everywhere in
 *  this codebase (`lib/money.ts`); this is the gate on the way in. */
export function amountError(
  value: string | number,
  { required = true, min = 0, max = 100_000, label = 'an amount' } = {},
): string | null {
  const raw = String(value).trim()
  if (!raw) return required ? `Enter ${label}.` : null

  const amount = Number(raw)
  if (!Number.isFinite(amount)) return `Enter ${label} as a number.`
  if (amount < min) return min === 0 ? 'That can’t be negative.' : `That must be at least ${min}.`
  if (amount > max) return `That looks too large — the limit is ${max.toLocaleString()}.`
  if (Math.round(amount * 100) !== amount * 100) return 'Use at most two decimal places.'

  return null
}
