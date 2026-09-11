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

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------

/** A whole number of things — seats, sessions, quantities.
 *
 *  Separate from `amountError` because the failures differ: 2.5 seats is nonsense where $2.50
 *  is ordinary, and `type="number"` accepts both. */
export function countError(
  value: string | number,
  { required = true, min = 1, max = 999, label = 'a number' } = {},
): string | null {
  const raw = String(value).trim()
  if (!raw) return required ? `Enter ${label}.` : null

  const count = Number(raw)
  if (!Number.isFinite(count)) return `Enter ${label} as a number.`
  if (!Number.isInteger(count)) return 'That has to be a whole number.'
  if (count < min) return `That must be at least ${min}.`
  if (count > max) return `That looks too large — the limit is ${max}.`

  return null
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

export const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

/** Today, in the timezone Melanite actually operates in.
 *
 *  `new Date().toISOString().slice(0, 10)` is UTC, which is a different day from about 5pm
 *  Denver onwards — so for the last seven hours of every working day it would call today
 *  "yesterday" and reject an appointment being booked for this afternoon.
 *
 *  `en-CA` because it formats as YYYY-MM-DD, which is what `<input type="date">` wants. */
export function todayInDenver(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(new Date())
}

/** The Denver calendar date and hour at a given instant.
 *
 *  Both read from ONE `formatToParts` call rather than two formatters: separate calls can
 *  straddle an hour boundary and return a date and an hour that never coexisted.
 *
 *  `hourCycle: 'h23'` because the en-US default renders midnight as hour 24, which would make
 *  every midnight compare as later than closing time. */
export function denverParts(at: Date): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Denver',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at)

  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? ''

  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    hour: Number(part('hour')),
  }
}

/** The calendar day before a YYYY-MM-DD.
 *
 *  Parsed at UTC noon, so neither a DST shift nor a server west of Greenwich can push the
 *  arithmetic onto the wrong day. The repo has no date library, on purpose. */
export function previousDay(date: string): string {
  const d = new Date(`${date}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

/**
 * Which Denver business day an evening-digest run is reporting on.
 *
 * Not simply "today". The job is scheduled twice — 02:00 and 03:00 UTC — because cron has no
 * concept of DST and 8pm Denver is one or the other depending on the season. Whichever run
 * lands before closing time is therefore reporting on the day that ended the night before.
 *
 * Asking "which day just ended" rather than gating on the hour also means a delayed run still
 * sends the right day instead of silently skipping the night, which matters because a missing
 * digest is meant to mean the job is broken.
 */
export function digestDayFor(at: Date, closeHour: number): string {
  const { date, hour } = denverParts(at)
  return hour >= closeHour ? date : previousDay(date)
}

/**
 * A date that must not be in the past.
 *
 * For the things that are being SCHEDULED — a course, an appointment, a licence that has to
 * still be valid. Deliberately not applied to dates that RECORD something that already
 * happened: the manual booking entry and the "payment received on" field exist precisely to
 * enter past dates, and blocking them there would break the feature.
 *
 * Compared as strings. Both sides are YYYY-MM-DD in the same timezone, which sorts correctly
 * and avoids parsing a date-only string into a Date — where it is read as UTC midnight and
 * lands on the previous day for anybody west of Greenwich.
 */
export function futureDateError(
  value: string,
  { required = true, label = 'a date', today = todayInDenver() } = {},
): string | null {
  const trimmed = value.trim()
  if (!trimmed) return required ? `Pick ${label}.` : null
  if (!DATE_ONLY.test(trimmed)) return 'That is not a valid date.'
  if (trimmed < today) return 'That date has already passed.'
  return null
}
