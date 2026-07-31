'use client'

import { useState, useTransition } from 'react'

import { Button } from '@/components/ui/button'
import { Field, Notice } from '@/components/ui/field'
import { EmailField, PhoneField } from '@/components/ui/validated-field'
import { cn } from '@/lib/cn'

import { CardForm } from '../pay/card-form'
import { enrollAndPayDeposit, enrollWithCherry } from './actions'

export interface CourseView {
  id: string
  day1Date: string
  day1Start: string
  day1End: string
  day2Date: string | null
  day2Start: string
  day2End: string
  depositAmount: string
  totalPrice: string
  seatsLeft: number
}

const usd = (v: string | number) =>
  Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

const dayLabel = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  })

/** Cherry's own floor for a plan. Same constant the package checkout uses — a training course
 *  is far above it, but stating the rule keeps the two pages honest with each other. */
const CHERRY_MINIMUM = 200

export function Enroll({
  courses,
  cherryEnabled,
}: {
  courses: CourseView[]
  /** False when Melanite has no Cherry link configured, which hides the option entirely. */
  cherryEnabled: boolean
}) {
  const [courseId, setCourseId] = useState(courses[0]?.id ?? '')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [licenseNumber, setLicenseNumber] = useState('')
  const [payInFull, setPayInFull] = useState(false)
  const [clientSecret, setClientSecret] = useState<string | null>(null)
  const [amount, setAmount] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [pending, start] = useTransition()

  const course = courses.find((c) => c.id === courseId)
  const balance = course
    ? (Number(course.totalPrice) - Number(course.depositAmount)).toFixed(2)
    : '0.00'

  /** Hands off to Cherry, having first reserved the seat. Full page navigation on purpose —
   *  the student is leaving, and a new tab that they close by habit loses the thread. */
  function beginCherry() {
    setError(null)
    start(async () => {
      const result = await enrollWithCherry({
        courseId,
        firstName,
        lastName,
        email,
        phone,
        licenseNumber,
      })
      if (result.error || !result.cherryUrl) {
        setError(result.error ?? 'Cherry is unavailable right now.')
        return
      }
      window.location.href = result.cherryUrl
    })
  }

  function begin() {
    setError(null)
    start(async () => {
      const result = await enrollAndPayDeposit({
        courseId,
        firstName,
        lastName,
        email,
        phone,
        licenseNumber,
        payInFull,
      })
      if (result.error) {
        setError(result.error)
        return
      }
      setClientSecret(result.clientSecret ?? null)
      setAmount(result.amount ?? 0)
    })
  }

  if (done) {
    return (
      <div className="mx-auto w-full max-w-lg space-y-4 text-center">
        <div className="rounded-card border border-success/30 bg-success/10 p-8">
          <h1 className="text-xl font-semibold">You&rsquo;re enrolled</h1>
          <p className="mt-2 text-sm text-ink-secondary">
            Your seat is confirmed for {course ? dayLabel(course.day1Date) : 'the course'}.
          </p>
          <p className="mt-4 text-2xl font-semibold tabular-nums">{usd(amount)}</p>
        </div>
        <p className="text-xs text-ink-faint">
          {payInFull
            ? 'Paid in full. Melanite will email joining details before the course.'
            : `Deposit received. The remaining ${usd(balance)} is due before the course — we'll email you a link.`}
        </p>
      </div>
    )
  }

  if (courses.length === 0) {
    return (
      <div className="mx-auto w-full max-w-lg rounded-card border border-line bg-surface p-8 text-center">
        <h1 className="text-lg font-semibold">No courses open right now</h1>
        <p className="mt-2 text-sm text-ink-muted">
          Contact Melanite to be told when the next date is announced.
        </p>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-lg space-y-5">
      <header>
        <h1 className="text-2xl font-semibold">Laser training</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Hands-on certification with Melanite Laser Suite.
        </p>
      </header>

      {!clientSecret && (
        <>
          <section className="space-y-3">
            <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">
              Choose a date
            </h2>
            <div className="space-y-2">
              {courses.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setCourseId(c.id)}
                  aria-pressed={courseId === c.id}
                  className={cn(
                    'block w-full rounded-card border p-4 text-left transition-colors',
                    courseId === c.id
                      ? 'border-gold bg-gold/5'
                      : 'border-line bg-surface hover:border-line-strong',
                  )}
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-sm font-medium">{dayLabel(c.day1Date)}</span>
                    <span className="text-sm font-semibold tabular-nums">
                      {usd(c.totalPrice)}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-ink-muted tabular-nums">
                    {c.day1Start}–{c.day1End}
                    {c.day2Date && ` · ${dayLabel(c.day2Date)} ${c.day2Start}–${c.day2End}`}
                  </p>
                  <p className="mt-1 text-xs text-ink-faint">
                    {c.seatsLeft} {c.seatsLeft === 1 ? 'seat' : 'seats'} left ·{' '}
                    {usd(c.depositAmount)} to reserve
                  </p>
                </button>
              ))}
            </div>
          </section>

          <section className="space-y-3 rounded-card border border-line bg-surface p-5">
            <h2 className="text-sm font-medium">Your details</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                id="firstName"
                label="First name"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                required
              />
              <Field
                id="lastName"
                label="Last name"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                required
              />
            </div>
            <EmailField
              id="email"
              label="Email"
              value={email}
              onChange={setEmail}
              required
              hint="Your enrolment confirmation and payment link go here."
            />
            <PhoneField id="phone" label="Phone" value={phone} onChange={setPhone} required />
            <Field
              id="licenseNumber"
              label="Professional license number"
              value={licenseNumber}
              onChange={(e) => setLicenseNumber(e.target.value)}
              required
              hint="Melanite records who was trained and under what license."
            />
          </section>

          {course && (
            <section className="space-y-3 rounded-card border border-line bg-surface p-5">
              <h2 className="text-sm font-medium">Payment</h2>
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => setPayInFull(false)}
                  aria-pressed={!payInFull}
                  className={cn(
                    'flex-1 rounded-field border px-3 py-2 text-left text-xs transition-colors',
                    !payInFull
                      ? 'border-gold bg-gold/10 text-gold'
                      : 'border-line text-ink-muted hover:border-line-strong',
                  )}
                >
                  {/* No `opacity-*` on this text. It is 12px, sits on a gold tint, and dimming
                      it put contrast under AA — the exact dark-theme failure the ink ramp was
                      raised to fix, reintroduced by an opacity modifier. Nothing caught it for
                      weeks because the accessibility spec scans this page, and with no course
                      scheduled there was no form on it to scan. */}
                  <span className="block font-medium">Deposit now</span>
                  <span className="block tabular-nums">{usd(course.depositAmount)}</span>
                  <span className="block">{usd(balance)} due before the course</span>
                </button>
                <button
                  type="button"
                  onClick={() => setPayInFull(true)}
                  aria-pressed={payInFull}
                  className={cn(
                    'flex-1 rounded-field border px-3 py-2 text-left text-xs transition-colors',
                    payInFull
                      ? 'border-gold bg-gold/10 text-gold'
                      : 'border-line text-ink-muted hover:border-line-strong',
                  )}
                >
                  <span className="block font-medium">Pay in full</span>
                  <span className="block tabular-nums">{usd(course.totalPrice)}</span>
                  <span className="block">nothing left to pay</span>
                </button>
              </div>
            </section>
          )}

          {error && <Notice>{error}</Notice>}

          <Button
            block
            onClick={begin}
            disabled={pending || !firstName || !lastName || !email || !phone || !course}
          >
            {pending
              ? 'Preparing…'
              : `Continue · ${usd(payInFull ? (course?.totalPrice ?? 0) : (course?.depositAmount ?? 0))}`}
          </Button>

          {/* Beside the card option, not behind it — the same placement as the package
              checkout. Hidden entirely when Melanite has no Cherry link configured: an offer
              that leads nowhere is worse than no offer. */}
          {cherryEnabled && course && Number(course.totalPrice) >= CHERRY_MINIMUM && (
            <>
              <div className="flex items-center gap-3 text-[11px] uppercase tracking-widest text-ink-faint">
                <span className="h-px flex-1 bg-line" />
                or
                <span className="h-px flex-1 bg-line" />
              </div>

              <Button
                block
                variant="outline"
                onClick={beginCherry}
                disabled={pending || !firstName || !lastName || !email || !phone}
              >
                {pending ? 'Preparing…' : 'Pay over time with Cherry →'}
              </Button>

              <p className="text-xs text-ink-faint">
                Cherry offers monthly payment plans for the full {usd(course.totalPrice)}, with no
                impact on your credit score to check your options. Your seat is held for three
                days while you apply — finish on Cherry&rsquo;s site, and Melanite will confirm
                your place once it comes through.
              </p>
            </>
          )}
        </>
      )}

      {clientSecret && (
        <section className="space-y-4 rounded-card border border-line bg-surface p-5">
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-ink-secondary">
              {payInFull ? 'Course, paid in full' : 'Deposit'}
            </span>
            <span className="text-xl font-semibold tabular-nums">{usd(amount)}</span>
          </div>
          <CardForm clientSecret={clientSecret} amount={amount} onPaid={() => setDone(true)} />
          <button
            type="button"
            onClick={() => setClientSecret(null)}
            className="w-full text-center text-xs text-ink-faint underline-offset-4 hover:underline"
          >
            Change your details
          </button>
        </section>
      )}
    </div>
  )
}
