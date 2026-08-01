'use client'

import { useState, type ComponentProps } from 'react'

import {
  amountError,
  countError,
  emailError,
  formatPhone,
  futureDateError,
  phoneError,
  todayInDenver,
} from '@/lib/validation'

import { Field } from './field'

// Fields that check what was typed.
//
// `type="tel"` and `type="email"` on their own do almost nothing here. `type="tel"` has never
// validated anything in any browser — it selects a keypad on a phone and accepts "hello"
// everywhere. `type="email"` does validate, but only when a native form SUBMIT happens, and
// several forms in this app are React-controlled with an onClick handler and no <form> around
// them, so that check never runs at all.
//
// So the rules are applied explicitly, from the same module the server actions use.
//
// WHEN the message appears matters as much as the message. Validating on every keystroke tells
// somebody their email is invalid while they are still typing the third character, which is
// both true and useless. These validate on BLUR — you have finished with the field — and then
// re-validate on every keystroke once an error is showing, so a correction clears immediately
// rather than making the person tab away to find out they fixed it.
//
// Both controlled and uncontrolled callers are supported, because the app has both: the
// onboarding and checkout forms hold their values in React state, while the booking and account
// forms are plain <form action={…}> with FormData. Forcing either to convert would be a large
// diff on working code to satisfy a component.

type Base = Omit<ComponentProps<typeof Field>, 'error' | 'onChange' | 'value' | 'type'>

interface ValidatedProps extends Base {
  /** Controlled. Omit for an uncontrolled field driven by `defaultValue` + `name`. */
  value?: string
  onChange?: (value: string) => void
  /** Force an error from outside — a server response, usually. Wins over the local one. */
  error?: string
  /** Empty is allowed. The field still rejects malformed input. */
  optional?: boolean
}

/** Controlled or not, the field still needs its current value to validate. */
function useFieldValue(value: string | undefined, defaultValue: unknown) {
  const [inner, setInner] = useState(typeof defaultValue === 'string' ? defaultValue : '')
  const controlled = value !== undefined
  return {
    current: controlled ? value : inner,
    set: (next: string) => {
      if (!controlled) setInner(next)
    },
  }
}

/**
 * Phone. Non-digits never make it into the value.
 *
 * Filtered at the source rather than complained about afterwards: there is no reason to accept
 * a letter into a phone field and then explain that it is wrong. Formatting is applied as they
 * type — `(208) 555-0134` — and a pasted `+1 208 555 0134` is accepted by dropping the 1 rather
 * than refused, because people paste that constantly.
 */
export function PhoneField({
  value,
  onChange,
  error,
  optional,
  defaultValue,
  ...props
}: ValidatedProps) {
  const [touched, setTouched] = useState(false)
  const { current, set } = useFieldValue(value, defaultValue)
  const local = touched ? phoneError(current, { required: !optional }) : null

  return (
    <Field
      {...props}
      type="tel"
      inputMode="tel"
      autoComplete="tel"
      value={current}
      // NO maxLength. It looks harmless — 14 is exactly "(208) 555-0134" — and it silently
      // corrupts every pasted number with a country code: `+1 208 555 0134` is 15 characters,
      // so the browser truncates it to `+1 208 555 013` BEFORE the formatter runs, and that
      // formats to `(120) 855-5013`. A plausible-looking wrong number is far worse than a
      // rejected one. The formatter already caps at ten digits, so the value cannot exceed
      // fourteen characters anyway and the attribute bought nothing.
      // Belt and braces for the forms that submit natively: `pattern` is enforced by the
      // browser on submit, and is ignored when the field is empty, which is what `optional`
      // needs. The formatter guarantees this shape, so it can only fail on a partial number.
      pattern="\(\d{3}\) \d{3}-\d{4}"
      onChange={(e) => {
        const next = formatPhone(e.target.value)
        set(next)
        onChange?.(next)
      }}
      onBlur={() => setTouched(true)}
      error={error ?? local ?? undefined}
    />
  )
}

/**
 * Email. Keystrokes cannot be filtered — every character is legal somewhere in an address — so
 * this checks on blur and names the specific problem, with the missing @ called out on its own
 * because it is by far the most common.
 */
export function EmailField({
  value,
  onChange,
  error,
  optional,
  defaultValue,
  ...props
}: ValidatedProps) {
  const [touched, setTouched] = useState(false)
  const { current, set } = useFieldValue(value, defaultValue)
  const local = touched ? emailError(current, { required: !optional }) : null

  const commit = (next: string) => {
    set(next)
    onChange?.(next)
  }

  return (
    <Field
      {...props}
      type="email"
      inputMode="email"
      autoComplete="email"
      spellCheck={false}
      value={current}
      // Trailing spaces come free with copy-paste and are invisible. Stripped on the way in
      // rather than rejecting an address that looks perfectly correct on screen.
      onChange={(e) => commit(e.target.value.trimStart())}
      onBlur={(e) => {
        setTouched(true)
        commit(e.target.value.trim())
      }}
      error={error ?? local ?? undefined}
    />
  )
}

interface NumericProps extends Base {
  value?: string | number
  onChange?: (value: string) => void
  error?: string
  optional?: boolean
  min?: number
  max?: number
}

/**
 * Money.
 *
 * `type="number"` on its own accepts `-50`, `1e9` and `0.001` — all of which reach a server
 * action as a perfectly valid Number, and none of which is a price. The third is the quiet one:
 * money is integer cents everywhere in this codebase, so `0.001` is not rejected, it is
 * ROUNDED, and somebody's price silently becomes something they did not type.
 *
 * `step` stays at 0.01 so the browser's own spinner agrees with the rule, rather than offering
 * increments the field will then refuse.
 */
export function AmountField({
  value,
  onChange,
  error,
  optional,
  min = 0,
  max = 100_000,
  defaultValue,
  label,
  ...props
}: NumericProps & { label: string }) {
  const [touched, setTouched] = useState(false)
  const { current, set } = useFieldValue(
    value === undefined ? undefined : String(value),
    defaultValue,
  )
  const local = touched
    ? amountError(current, { required: !optional, min, max, label: label.toLowerCase() })
    : null

  return (
    <Field
      {...props}
      label={label}
      type="number"
      inputMode="decimal"
      step={0.01}
      min={min}
      max={max}
      value={current}
      onChange={(e) => {
        set(e.target.value)
        onChange?.(e.target.value)
      }}
      onBlur={() => setTouched(true)}
      error={error ?? local ?? undefined}
    />
  )
}

/** A whole number of things — seats, sessions, quantities. 2.5 seats is nonsense where $2.50 is
 *  ordinary, so this is a separate component rather than an option on the one above. */
export function IntegerField({
  value,
  onChange,
  error,
  optional,
  min = 1,
  max = 999,
  defaultValue,
  label,
  ...props
}: NumericProps & { label: string }) {
  const [touched, setTouched] = useState(false)
  const { current, set } = useFieldValue(
    value === undefined ? undefined : String(value),
    defaultValue,
  )
  const local = touched
    ? countError(current, { required: !optional, min, max, label: label.toLowerCase() })
    : null

  return (
    <Field
      {...props}
      label={label}
      type="number"
      inputMode="numeric"
      step={1}
      min={min}
      max={max}
      value={current}
      onChange={(e) => {
        set(e.target.value)
        onChange?.(e.target.value)
      }}
      onBlur={() => setTouched(true)}
      error={error ?? local ?? undefined}
    />
  )
}

/** A date being SCHEDULED, which cannot be in the past.
 *
 *  `min` is set as well as validated: the browser then greys out past days in its own picker,
 *  which stops the mistake rather than reporting it. Not for dates that RECORD something that
 *  already happened — those are supposed to be in the past. */
export function FutureDateField({
  value,
  onChange,
  error,
  optional,
  defaultValue,
  label,
  ...props
}: Omit<NumericProps, 'min' | 'max'> & { label: string }) {
  const [touched, setTouched] = useState(false)
  const { current, set } = useFieldValue(
    value === undefined ? undefined : String(value),
    defaultValue,
  )
  const local = touched ? futureDateError(current, { required: !optional, label }) : null

  return (
    <Field
      {...props}
      label={label}
      type="date"
      min={todayInDenver()}
      value={current}
      onChange={(e) => {
        set(e.target.value)
        onChange?.(e.target.value)
      }}
      onBlur={() => setTouched(true)}
      error={error ?? local ?? undefined}
    />
  )
}
