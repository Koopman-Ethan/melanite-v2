import 'server-only'

// Email delivery. v1 used Resend, so this keeps that provider rather than introducing
// another account to manage.
//
// With no RESEND_API_KEY configured, messages are logged to the server console instead of
// sent. That is deliberate for development, but it means a reset link on a machine without
// the key goes nowhere visible to the recipient — hence the loud warning. It must not fail
// silently, because "the email never arrived" is indistinguishable from a broken flow.

import { PROVIDER_ALREADY_HOLDS } from '@/lib/payments/direction'

const RESEND_ENDPOINT = 'https://api.resend.com/emails'

/** Where Melanite itself is told about calendar activity.
 *
 *  A constant rather than a database setting or a required variable: it is one business inbox,
 *  it changes about never, and an unset env var must not be able to quietly turn the alerts
 *  off. The override exists so a preview environment can point somewhere else without a commit
 *  — though outside production `resolveRecipient` redirects everything anyway. */
export const MELANITE_NOTIFY_EMAIL =
  process.env.MELANITE_NOTIFY_EMAIL?.trim() || 'melanitelasersuite@gmail.com'

export interface EmailMessage {
  to: string
  subject: string
  html: string
  text: string
}

export interface SendResult {
  delivered: boolean
  /** Why it did not go. `not-configured` and `failed` need DIFFERENT things said to a human —
   *  one is "set the key", the other is "that address was rejected" — and reporting both as a
   *  bare `delivered: false` told an admin the wrong thing. */
  reason?: 'not-configured' | 'failed'
  /** Provider detail, for an admin-facing message. Never shown to a client. */
  detail?: string
}

/** Turns a Resend rejection into something an admin can act on. */
function friendlyReason(status: number, body: string): string {
  if (body.includes('testing email address')) {
    return 'Resend refuses example.com and other reserved domains — use a real address'
  }
  if (status === 403 || body.includes('not verified')) {
    return 'the sending domain is not verified in Resend'
  }
  if (status === 429) return 'the email service is rate limiting — try again shortly'
  return `the email service returned ${status}`
}

/**
 * Where this message may actually be sent.
 *
 * Resend has no test mode. One account, one set of credentials, and an address in a dev
 * database is a real inbox — appdev is a full copy of production data, so "send the client a
 * booking confirmation" from a test run means emailing an actual client of Melanite's about an
 * appointment that does not exist.
 *
 * So outside production, every message is redirected to a single address and the real recipient
 * is moved into the subject, where it is still testable but harmless. The scrubber rewrites
 * client addresses to example.com, which Resend rejects outright — that protected us by
 * accident, and only for rows the scrubber reaches.
 *
 * Returns null when there is nowhere safe to send, and the caller does not send at all. Refusing
 * is the right default: the failure mode of guessing wrong is mailing a stranger.
 */
/** Domains reserved by IANA for documentation and testing. No mailbox behind any of them,
 *  ever, by standard — RFC 2606 and RFC 6761.
 *
 *  The e2e suite addresses its fixtures here precisely because they cannot reach anybody, and
 *  Resend rejects them outright. Redirecting one to a real inbox turns a guaranteed no-op into
 *  real mail: a full test run put five messages in a real person's inbox, which is worse than
 *  the behaviour the redirect was added to prevent. */
const NOWHERE = /@(?:[^@]*\.)?(?:example\.(?:com|org|net)|test|invalid|localhost)$/i

export function resolveRecipient(intended: string): {
  to: string | null
  subject(original: string): string
  note?: string
} {
  const env = process.env.MELANITE_ENV?.trim().toLowerCase()

  if (env === 'prod') return { to: intended, subject: (s) => s }

  // Checked before the redirect, and deliberately not in production — a reserved address in a
  // production database is a data problem worth seeing Resend reject, not something to swallow.
  if (NOWHERE.test(intended.trim())) {
    return {
      to: null,
      subject: (s) => s,
      note: `${intended} is a reserved address that can never receive mail — nothing sent`,
    }
  }

  const redirect = process.env.EMAIL_REDIRECT_TO?.trim()
  if (!redirect) {
    return {
      to: null,
      subject: (s) => s,
      note:
        'MELANITE_ENV is not prod and EMAIL_REDIRECT_TO is not set, so there is nowhere safe ' +
        'to send. Set EMAIL_REDIRECT_TO to your own address.',
    }
  }

  // The intended recipient in the subject, so a redirected message is never mistaken for one
  // that reached the person named inside it.
  return { to: redirect, subject: (s) => `[to: ${intended}] ${s}` }
}

export async function sendEmail(message: EmailMessage): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY
  const from = process.env.RESEND_FROM ?? 'Melanite Laser Suite <noreply@melanitesuite.com>'

  const route = resolveRecipient(message.to)
  if (route.to === null) {
    console.warn(
      `\n[email] NOT SENT — ${route.note}\n` +
        `  intended: ${message.to}\n` +
        `  subject:  ${message.subject}\n`,
    )
    return { delivered: false, reason: 'not-configured', detail: route.note }
  }

  if (route.to !== message.to) {
    console.log(`[email] ${message.to} -> ${route.to} (non-production redirect)`)
  }

  message = { ...message, to: route.to, subject: route.subject(message.subject) }

  if (!apiKey) {
    console.warn(
      `\n[email] RESEND_API_KEY is not set — NOT SENT.\n` +
        `  to:      ${message.to}\n` +
        `  subject: ${message.subject}\n` +
        `  ${message.text.replace(/\n/g, '\n  ')}\n`,
    )
    return { delivered: false, reason: 'not-configured' }
  }

  // Returns rather than throws. Every caller is reporting something that has ALREADY happened —
  // a booking made, a fee charged, an invite issued — so a failed email must never be mistaken
  // for a failed operation. Throwing invited exactly that.
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
    })

    if (!res.ok) {
      const body = (await res.text()).slice(0, 300)
      console.error(`[email] Resend ${res.status} sending to ${message.to}: ${body}`)
      return { delivered: false, reason: 'failed', detail: friendlyReason(res.status, body) }
    }

    return { delivered: true }
  } catch (err) {
    console.error(`[email] could not reach Resend for ${message.to}`, err)
    return { delivered: false, reason: 'failed', detail: 'the email service could not be reached' }
  }
}

export function passwordResetEmail(firstName: string, url: string): Omit<EmailMessage, 'to'> {
  return {
    subject: 'Reset your Melanite password',
    text: [
      `Hi ${firstName},`,
      '',
      'Use the link below to set a new password for your Melanite Laser Suite account.',
      'It expires in one hour and can only be used once.',
      '',
      url,
      '',
      "If you didn't request this, you can ignore this email — your password will not change.",
    ].join('\n'),
    html: `
      <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;color:#171717">
        <h1 style="font-size:20px;margin:0 0 16px">Reset your password</h1>
        <p style="margin:0 0 16px;line-height:1.6">Hi ${firstName},</p>
        <p style="margin:0 0 24px;line-height:1.6">
          Use the button below to set a new password for your Melanite Laser Suite account.
          It expires in one hour and can only be used once.
        </p>
        <p style="margin:0 0 24px">
          <a href="${url}" style="display:inline-block;background:#B8965A;color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px;font-size:14px">
            Set a new password
          </a>
        </p>
        <p style="margin:0 0 8px;font-size:13px;color:#666;line-height:1.6">
          If the button doesn't work, paste this into your browser:
        </p>
        <p style="margin:0 0 24px;font-size:13px;color:#666;word-break:break-all">${url}</p>
        <p style="margin:0;font-size:13px;color:#666;line-height:1.6">
          If you didn't request this, you can ignore this email — your password will not change.
        </p>
      </div>
    `,
  }
}

/** Shared shell so every Melanite email looks like the same sender. */
function wrap(heading: string, body: string, cta?: { label: string; url: string }): string {
  return `
    <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;color:#171717">
      <h1 style="font-size:20px;margin:0 0 16px">${heading}</h1>
      ${body}
      ${
        cta
          ? `<p style="margin:24px 0">
               <a href="${cta.url}" style="display:inline-block;background:#B8965A;color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px;font-size:14px">${cta.label}</a>
             </p>
             <p style="margin:0 0 8px;font-size:13px;color:#666;line-height:1.6">If the button doesn't work, paste this into your browser:</p>
             <p style="margin:0 0 24px;font-size:13px;color:#666;word-break:break-all">${cta.url}</p>`
          : ''
      }
      <p style="margin:0;font-size:13px;color:#666;line-height:1.6">Melanite Laser Suite</p>
    </div>
  `
}

const p = (text: string) => `<p style="margin:0 0 16px;line-height:1.6">${text}</p>`

/** How an appointment is named to a client: weekday, date, and the time they must arrive.
 *
 *  Always Denver, never the server's zone. A confirmation is the one message where an hour's
 *  drift is the difference between arriving and missing it. */
export function appointmentWhen(startTime: Date): string {
  return startTime.toLocaleString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Denver',
  })
}

export function bookingPaymentLinkEmail(input: {
  clientName: string
  providerName: string
  serviceName: string
  when: string
  amount: string
  url: string
}): Omit<EmailMessage, 'to'> {
  const first = input.clientName.split(' ')[0]
  return {
    subject: `Your appointment with ${input.providerName} — payment link`,
    text: [
      `Hi ${first},`,
      '',
      `${input.serviceName} with ${input.providerName}`,
      input.when,
      `Amount due: ${input.amount}`,
      '',
      'Pay here:',
      input.url,
      '',
      'You can add a tip at checkout. Questions? Reply to your provider directly.',
    ].join('\n'),
    html: wrap(
      'Your appointment is booked',
      p(`Hi ${first},`) +
        p(`<strong>${input.serviceName}</strong> with ${input.providerName}<br>${input.when}`) +
        p(`Amount due: <strong>${input.amount}</strong>`) +
        p('You can add a tip at checkout.'),
      { label: `Pay ${input.amount}`, url: input.url },
    ),
  }
}

/** The appointment is on. Sent when the money lands, or when a prepaid session is booked.
 *
 *  Deliberately NOT sent when the booking row is created: at that point nothing has been paid,
 *  and telling somebody their appointment is confirmed before they have paid for it invites
 *  them to turn up for one that was never held.
 *
 *  A package redemption has no payment at all, so this is the only thing that ever tells that
 *  client anything. */
export function bookingConfirmedEmail(input: {
  clientName: string
  providerName: string
  serviceName: string
  when: string
  /** Null when nothing was charged today, which is not the same as free — see `coveredBy`. */
  amount: string | null
  /** What covered it when `amount` is null. Required in practice: telling somebody who bought a
   *  prepaid balance that their session "came from a package" describes a product they did not
   *  buy, and the two are genuinely different things. */
  coveredBy?: 'package' | 'prepaid'
}): Omit<EmailMessage, 'to'> {
  const first = input.clientName.split(' ')[0]
  const paid = input.amount
    ? `Paid: ${input.amount}. Stripe has emailed your receipt separately.`
    : input.coveredBy === 'prepaid'
      ? 'This appointment was paid from the prepaid balance you already hold.'
      : 'This session came from a package you have already paid for.'

  return {
    subject: `Confirmed: ${input.serviceName} on ${input.when}`,
    text: [
      `Hi ${first},`,
      '',
      'Your appointment is confirmed.',
      '',
      `${input.serviceName} with ${input.providerName}`,
      input.when,
      '',
      paid,
      '',
      'Need to change or cancel? Contact your provider directly — please give as much notice',
      'as you can, as a late cancellation may be charged.',
    ].join('\n'),
    html: wrap(
      'Your appointment is confirmed',
      p(`Hi ${first},`) +
        p(`<strong>${input.serviceName}</strong> with ${input.providerName}<br>${input.when}`) +
        p(paid) +
        p(
          'Need to change or cancel? Contact your provider directly — please give as much ' +
            'notice as you can, as a late cancellation may be charged.',
        ),
    ),
  }
}

/** The appointment is off.
 *
 *  The counterpart to the confirmation, and arguably the more important of the two: once a
 *  client has been told an appointment exists, they will act on that until told otherwise.
 *  Confirming without cancelling is worse than sending neither, because it earns trust in a
 *  channel that then goes quiet at the one moment it matters. */
export function bookingCancelledEmail(input: {
  clientName: string
  providerName: string
  serviceName: string
  when: string
  /** What went back to the client, if anything. Three states rather than a boolean and a
   *  separate "which kind" flag, so "nothing returned, to a package" cannot be expressed. */
  returned: false | 'package' | 'prepaid'
}): Omit<EmailMessage, 'to'> {
  const first = input.clientName.split(' ')[0]
  const reassurance =
    input.returned === 'package'
      ? 'The session has been returned to your package — nothing has been lost, and you can book it again whenever suits.'
      : input.returned === 'prepaid'
        ? 'The amount has gone back onto your prepaid balance — nothing has been lost, and you can put it towards another appointment whenever suits.'
        : 'If you have already paid, any refund will come back to your original payment method.'

  return {
    subject: `Cancelled: ${input.serviceName} on ${input.when}`,
    text: [
      `Hi ${first},`,
      '',
      'Your appointment has been cancelled.',
      '',
      `${input.serviceName} with ${input.providerName}`,
      input.when,
      '',
      reassurance,
      '',
      'To rebook, contact your provider directly.',
    ].join('\n'),
    html: wrap(
      'Your appointment has been cancelled',
      p(`Hi ${first},`) +
        p(`<strong>${input.serviceName}</strong> with ${input.providerName}<br>${input.when}`) +
        p(reassurance) +
        p('To rebook, contact your provider directly.'),
    ),
  }
}

export function packageLinkEmail(input: {
  clientName: string | null
  providerName: string
  packageName: string
  sessions: number
  amount: string
  url: string
}): Omit<EmailMessage, 'to'> {
  const first = input.clientName?.split(' ')[0] ?? 'there'
  return {
    subject: `Your ${input.packageName} from ${input.providerName}`,
    text: [
      `Hi ${first},`,
      '',
      `${input.packageName} — ${input.sessions} sessions with ${input.providerName}`,
      `Total: ${input.amount}`,
      '',
      'Purchase here:',
      input.url,
      '',
      'Monthly payment plans through Cherry are available at checkout.',
    ].join('\n'),
    html: wrap(
      input.packageName,
      p(`Hi ${first},`) +
        p(`<strong>${input.sessions} sessions</strong> with ${input.providerName}`) +
        p(`Total: <strong>${input.amount}</strong>`) +
        p('Monthly payment plans through Cherry are available at checkout.'),
      { label: `Purchase — ${input.amount}`, url: input.url },
    ),
  }
}

/** Tells a client their card on file was charged.
 *
 *  Sent because taking money from someone who is not present and saying nothing is indefensible
 *  — they agreed to the fee, not to finding out from their statement. Failure to send must not
 *  undo the charge, so the caller swallows errors. */
export function feeChargedEmail(input: {
  clientName: string
  providerName: string
  reason: 'no_show_fee' | 'late_cancellation_fee'
  amount: string
  when: string
}): Omit<EmailMessage, 'to'> {
  const first = input.clientName.split(' ')[0]
  const label =
    input.reason === 'no_show_fee' ? 'missed appointment fee' : 'late cancellation fee'

  return {
    subject: `${input.amount} ${label} — Melanite Laser Suite`,
    text: [
      `Hi ${first},`,
      '',
      `We've charged the card you left on file ${input.amount} — a ${label} for your appointment with ${input.providerName} on ${input.when}.`,
      '',
      'You agreed to this when you paid, as set out in the appointment policy.',
      '',
      'If you think this is a mistake, contact your provider and they will sort it out.',
    ].join('\n'),
    html: wrap(
      `${label.charAt(0).toUpperCase() + label.slice(1)}`,
      p(`Hi ${first},`) +
        p(
          `We've charged the card you left on file <strong>${input.amount}</strong> — a ${label} for your appointment with ${input.providerName} on ${input.when}.`,
        ) +
        p('You agreed to this when you paid, as set out in the appointment policy.') +
        p('If you think this is a mistake, contact your provider and they will sort it out.'),
    ),
  }
}

export function trainingBalanceEmail(input: {
  firstName: string
  amount: string
  courseDate: string
  dueDate: string | null
  url: string
}): Omit<EmailMessage, 'to'> {
  const when = new Date(`${input.courseDate}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
  const due = input.dueDate
    ? new Date(`${input.dueDate}T12:00:00Z`).toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        timeZone: 'UTC',
      })
    : null

  return {
    subject: `Balance due for your training — ${input.amount}`,
    text: [
      `Hi ${input.firstName},`,
      '',
      `Your remaining balance for the laser training course on ${when} is ${input.amount}.`,
      due ? `It is due by ${due}.` : '',
      '',
      'Pay here:',
      input.url,
      '',
      'This link stays valid — you can come back to it any time.',
    ]
      .filter(Boolean)
      .join('\n'),
    html: wrap(
      'Your training balance',
      p(`Hi ${input.firstName},`) +
        p(
          `Your remaining balance for the laser training course on <strong>${when}</strong> is <strong>${input.amount}</strong>.`,
        ) +
        (due ? p(`It is due by <strong>${due}</strong>.`) : '') +
        p('This link stays valid — you can come back to it any time.'),
      { label: `Pay ${input.amount}`, url: input.url },
    ),
  }
}

export function trainingEnrolledEmail(input: {
  firstName: string
  courseDate: string
  deposit: string
  balance: string
  url: string
}): Omit<EmailMessage, 'to'> {
  const when = new Date(`${input.courseDate}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })

  return {
    subject: `You're enrolled — laser training, ${when}`,
    text: [
      `Hi ${input.firstName},`,
      '',
      `Your seat is confirmed for the laser training course on ${when}.`,
      `Deposit paid: ${input.deposit}`,
      `Balance remaining: ${input.balance}`,
      '',
      'You can pay the balance any time here:',
      input.url,
      '',
      'Melanite will be in touch with joining details before the course.',
    ].join('\n'),
    html: wrap(
      "You're enrolled",
      p(`Hi ${input.firstName},`) +
        p(`Your seat is confirmed for the laser training course on <strong>${when}</strong>.`) +
        p(`Deposit paid: <strong>${input.deposit}</strong><br>Balance remaining: <strong>${input.balance}</strong>`) +
        p('Melanite will be in touch with joining details before the course.'),
      { label: `Pay the balance — ${input.balance}`, url: input.url },
    ),
  }
}

/** Tells a PROVIDER that a client paid one of their checkout links.
 *
 *  The first message here addressed to staff rather than a client, and the only one that asks
 *  permission first: it honours `providers.notifyBookingConfirmed`, shown in account settings as
 *  "Payment received — when a client pays through your checkout link". A client's receipt is not
 *  optional; this is.
 *
 *  Leads with the provider's SHARE rather than the gross. The gross is the larger number and the
 *  one on the client's receipt, so quoting it alone would be the friendlier-looking choice and
 *  the wrong one — the share is what reaches their bank. Both appear, because a provider
 *  reconciling against what a client tells them they paid needs to see the same figure the
 *  client saw.
 */
export function providerPaidEmail(input: {
  firstName: string
  clientName: string
  /** What was bought, already phrased for a human: a service name or a package name. */
  what: string
  /** The appointment time for a booking. Null for a package, which buys no single date. */
  when: string | null
  /** What actually left the client's card — the service plus any tip. */
  charged: string
  /** Null when no tip was left. An explicit "$0.00 tip" line reads as a complaint. */
  tip: string | null
  payout: string
  url: string
}): Omit<EmailMessage, 'to'> {
  const tipLine = input.tip
    ? `Includes a ${input.tip} tip, which is yours in full.`
    : null

  return {
    subject: `Payment received — ${input.clientName} paid ${input.charged}`,
    text: [
      `Hi ${input.firstName},`,
      '',
      `${input.clientName} has paid for ${input.what}.`,
      input.when ?? '',
      '',
      `They paid: ${input.charged}`,
      tipLine ?? '',
      `Your share: ${input.payout}`,
      '',
      'See it against everything else here:',
      input.url,
    ]
      .filter((line, i, all) => line !== '' || all[i - 1] !== '')
      .join('\n'),
    html: wrap(
      'Payment received',
      p(`Hi ${input.firstName},`) +
        p(
          `<strong>${input.clientName}</strong> has paid for ${input.what}.` +
            (input.when ? `<br>${input.when}` : ''),
        ) +
        p(
          `They paid: <strong>${input.charged}</strong><br>` +
            `Your share: <strong>${input.payout}</strong>`,
        ) +
        (tipLine ? p(tipLine) : ''),
      { label: 'View your earnings', url: input.url },
    ),
  }
}

export function providerInviteEmail(input: {
  invitedBy: string
  url: string
  expiresInDays: number
}): Omit<EmailMessage, 'to'> {
  return {
    subject: "You're invited to join Melanite Laser Suite",
    text: [
      'Hi,',
      '',
      `${input.invitedBy} has invited you to join the Melanite provider network.`,
      '',
      'Set up your account here:',
      input.url,
      '',
      `This link expires in ${input.expiresInDays} days and can only be used once.`,
      '',
      'Setup takes about 10 minutes: create a password, add your license details, connect',
      'your bank account for payouts, and choose the services you offer.',
    ].join('\n'),
    html: wrap(
      'Join the Melanite provider network',
      p(`${input.invitedBy} has invited you to join Melanite Laser Suite.`) +
        p(
          'Setup takes about 10 minutes: create a password, add your license details, connect your bank account for payouts, and choose the services you offer.',
        ) +
        p(
          `<strong>This link expires in ${input.expiresInDays} days</strong> and can only be used once.`,
        ),
      { label: 'Set up your account', url: input.url },
    ),
  }
}

// ---------------------------------------------------------------------------
// Melanite's own calendar alerts
//
// The first messages addressed to the business rather than to a client or a provider. Keoni
// asked to hear about every booking and every cancellation, including the rental room, because
// nothing told her: the client is emailed, the provider is emailed, and the calendar changes
// under her without a word.
//
// Sent when the appointment ROW is created, not when it is paid for — deliberately unlike
// `bookingConfirmedEmail`, which waits for the money. What she is being told about is the laser
// being taken, and a Groupon, cash, package or prepaid booking never produces a payment event at
// all, so waiting for one would hide most of her calendar from her.
// ---------------------------------------------------------------------------

/** The three room blocks, named the way they are named to a person. Shared with the Stripe line
 *  item so the room is described identically in a receipt and in an alert. */
export const ROOM_SLOT_LABELS: Record<'full' | 'am' | 'pm', string> = {
  full: 'Full day',
  am: 'Morning',
  pm: 'Afternoon',
}

/** A rental date (`YYYY-MM-DD`, a `date` column with no time in it) as a person reads it.
 *
 *  Parsed as UTC noon and formatted in UTC. Not `appointmentWhen`: that takes an instant and
 *  converts it to Denver, and putting a bare date through it lands on the previous day for any
 *  server west of UTC. */
export function roomDateLabel(rentalDate: string): string {
  return new Date(`${rentalDate}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

const EXTERNAL_METHOD_LABELS: Record<string, string> = {
  groupon: 'Groupon',
  cherry: 'Cherry',
  cash: 'Cash',
  check: 'Check',
  other: 'another method',
}

/** One line describing what happens about money on this appointment.
 *
 *  Worth its own function rather than a ternary in the template: the five payment sources mean
 *  genuinely different things to Keoni, and some of them mean somebody owes somebody money.
 *
 *  The direction is read from `PROVIDER_ALREADY_HOLDS` rather than restated here. Groupon, cash
 *  and cheques are collected BY the provider, so Melanite's share has to be invoiced back —
 *  which is the whole reason `price` is required on an external booking. Cherry runs the other
 *  way: it pays Melanite, which then owes the provider. Saying "collected by the provider" about
 *  a Cherry booking would point an invoice at somebody who never touched the money, and that is
 *  a mistake this codebase has made once already.
 */
export function bookingPaymentSummary(input: {
  paymentSource: string
  externalMethod: string | null
  /** The `money()` column, so a string like '180.00'. */
  price: string
}): string {
  const amount = `$${Number(input.price).toFixed(2)}`

  switch (input.paymentSource) {
    case 'external': {
      const raw = input.externalMethod ?? ''
      const method = EXTERNAL_METHOD_LABELS[raw] ?? 'an external method'

      if (PROVIDER_ALREADY_HOLDS.has(raw)) {
        return `${amount} paid by ${method}, collected by the provider — Melanite's share to invoice`
      }
      if (raw === 'cherry') {
        return `${amount} financed through Cherry, which pays Melanite — the provider's share is still owed`
      }
      // No method recorded, or one this list has never heard of. Naming a direction here would
      // be guessing at who owes whom, which is the one thing this line must not do.
      return `${amount} paid by ${method}, outside Melanite`
    }
    case 'package_redemption':
      return 'A package session the client already owns — nothing to collect'
    case 'prepaid':
      return Number(input.price) > 0
        ? `Paid from a prepaid balance, with ${amount} still due on a payment link`
        : 'Paid in full from a prepaid balance — nothing to collect'
    case 'comped':
      return 'Comped — no charge'
    default:
      return `${amount} due on a payment link`
  }
}

/** Tells Melanite that an appointment appeared on, or left, the calendar.
 *
 *  One template for both events rather than two nearly identical ones: every field is the same
 *  and only the verb changes, so two copies would drift the first time a line was added. */
export function deskBookingEmail(input: {
  event: 'booked' | 'cancelled'
  clientName: string
  providerName: string
  serviceName: string
  when: string
  durationMins: number
  paying: string
  url: string
}): Omit<EmailMessage, 'to'> {
  const verb = input.event === 'booked' ? 'Booked' : 'Cancelled'

  return {
    subject: `${verb}: ${input.serviceName} — ${input.when}`,
    text: [
      input.event === 'booked'
        ? 'An appointment has been booked.'
        : 'An appointment has been cancelled.',
      '',
      input.serviceName,
      `${input.when} (${input.durationMins} minutes)`,
      '',
      `Client:   ${input.clientName}`,
      `Provider: ${input.providerName}`,
      `Payment:  ${input.paying}`,
      '',
      'See the calendar:',
      input.url,
    ].join('\n'),
    html: wrap(
      input.event === 'booked' ? 'Appointment booked' : 'Appointment cancelled',
      p(`<strong>${input.serviceName}</strong><br>${input.when} (${input.durationMins} minutes)`) +
        p(
          `Client: <strong>${input.clientName}</strong><br>` +
            `Provider: ${input.providerName}<br>` +
            `Payment: ${input.paying}`,
        ),
      { label: 'Open the calendar', url: input.url },
    ),
  }
}

/** Tells Melanite that the rental room was taken, or given back.
 *
 *  Sent when the rental is CONFIRMED, not when the 30-minute hold is created. A hold that dies
 *  in an abandoned checkout never occupied the room, and alerting on it would produce a booking
 *  email with no cancellation to match when the sweep clears it. */
export function deskRoomRentalEmail(input: {
  event: 'booked' | 'cancelled'
  providerName: string
  slotLabel: string
  dateLabel: string
  price: string
  /** True when the provider cancelled inside 24 hours, so the refund is Keoni's decision and
   *  the rental is sitting in the admin queue waiting for it. */
  awaitingRefundDecision?: boolean
  url: string
}): Omit<EmailMessage, 'to'> {
  const verb = input.event === 'booked' ? 'Room booked' : 'Room cancelled'
  const amount = `$${Number(input.price).toFixed(2)}`
  const note = input.awaitingRefundDecision
    ? 'Cancelled inside 24 hours, so the refund is yours to decide — it is waiting in the admin queue. The block is free either way.'
    : null

  return {
    subject: `${verb}: ${input.slotLabel}, ${input.dateLabel}`,
    text: [
      input.event === 'booked'
        ? 'The treatment room has been rented.'
        : 'A room rental has been cancelled.',
      '',
      `${input.slotLabel}, ${input.dateLabel}`,
      `Provider: ${input.providerName}`,
      `Paid:     ${amount}`,
      ...(note ? ['', note] : []),
      '',
      'See the calendar:',
      input.url,
    ].join('\n'),
    html: wrap(
      input.event === 'booked' ? 'Room rented' : 'Room rental cancelled',
      p(`<strong>${input.slotLabel}, ${input.dateLabel}</strong>`) +
        p(`Provider: <strong>${input.providerName}</strong><br>Paid: ${amount}`) +
        (note ? p(note) : ''),
      { label: 'Open the calendar', url: input.url },
    ),
  }
}

// ---------------------------------------------------------------------------
// Booking access — when the medical-director gate opens or closes
//
// `canBook` requires `medicalDirectorStatus === 'active'`, so a failed subscription payment
// silently revokes a provider's ability to create appointments. On 2026-08-23 that happened to
// a real provider and nothing told her or Melanite; it was found a day later, in Stripe.
//
// Sent on the TRANSITION of that column, never per Stripe event — see the handlers for why.
// ---------------------------------------------------------------------------

/** Tells a provider their booking access has closed.
 *
 *  Three things this has to say, in this order of importance:
 *
 *  1. **Existing appointments still stand.** Only creating new ones is blocked, which is true,
 *     and it is the difference between a provider fixing their billing and a provider ringing
 *     every client on their week in a panic.
 *  2. What to do about it.
 *  3. For `past_due`, that Stripe keeps retrying — and that the subscription cancels if those
 *     run out, which is a harder state to come back from than a billing update.
 *
 *  Never says "your card". The provider this was written for pays by Link, which carries no card
 *  object at all — the same trap already recorded for `paymentMethodType`. "Update your card"
 *  sends somebody looking for something that is not there.
 *
 *  Not gated on `providers.notifyMembershipBilling`, deliberately. That toggle exists, is shown
 *  in account settings and is read by nothing, so gating this on it would look like tidying up.
 *  It is not a billing reminder; it is notice that somebody cannot work. Same argument as the
 *  cancellation email.
 */
export function bookingAccessLostEmail(input: {
  firstName: string
  reason: 'past_due' | 'inactive'
  url: string
}): Omit<EmailMessage, 'to'> {
  const pastDue = input.reason === 'past_due'

  const what = pastDue
    ? 'The payment for your medical director subscription did not go through, so booking is paused on your account.'
    : 'Your medical director subscription has ended, so booking is paused on your account.'

  const fix = pastDue
    ? 'Update the payment method on file and booking switches back on by itself, usually within a few minutes of the payment clearing.'
    : 'Start the subscription again and booking switches back on by itself.'

  const urgency = pastDue
    ? 'The payment will be retried automatically over the next couple of weeks. If those retries do not succeed the subscription is cancelled, which takes more to undo than a billing update — so it is worth sorting out now.'
    : null

  return {
    subject: pastDue
      ? 'Action needed — booking is paused on your Melanite account'
      : 'Your medical director subscription has ended',
    text: [
      `Hi ${input.firstName},`,
      '',
      what,
      '',
      'Appointments already in your calendar are not affected — they stand, and your clients',
      'need do nothing. What is paused is creating NEW appointments.',
      '',
      fix,
      ...(urgency ? ['', urgency] : []),
      '',
      'Manage it here:',
      input.url,
    ].join('\n'),
    html: wrap(
      'Booking is paused on your account',
      p(`Hi ${input.firstName},`) +
        p(what) +
        p(
          '<strong>Appointments already in your calendar are not affected</strong> — they stand, ' +
            'and your clients need do nothing. What is paused is creating new appointments.',
        ) +
        p(fix) +
        (urgency ? p(urgency) : ''),
      { label: 'Manage your subscription', url: input.url },
    ),
  }
}

/** Booking is back on. Short on purpose — it closes a loop the message above opened, and the
 *  only fact that matters is that they can work again. */
export function bookingAccessRestoredEmail(input: {
  firstName: string
  url: string
}): Omit<EmailMessage, 'to'> {
  return {
    subject: 'Booking is back on for your Melanite account',
    text: [
      `Hi ${input.firstName},`,
      '',
      'Your medical director subscription is up to date and booking is switched back on. You can',
      'create appointments again straight away.',
      '',
      input.url,
    ].join('\n'),
    html: wrap(
      'Booking is back on',
      p(`Hi ${input.firstName},`) +
        p(
          'Your medical director subscription is up to date and booking is switched back on. ' +
            'You can create appointments again straight away.',
        ),
      { label: 'Open Melanite', url: input.url },
    ),
  }
}

/** Tells Melanite that a provider's booking access changed.
 *
 *  `canSelfServe` is the line Keoni actually acts on: a provider with a Stripe billing customer
 *  can fix a past-due subscription themselves in the portal, and one without cannot and needs
 *  her. Leaving it out would report that something happened and leave her to work out whether
 *  it is hers to deal with. */
export function deskProviderAccessEmail(input: {
  event: 'lost' | 'restored'
  providerName: string
  reason: 'past_due' | 'inactive' | 'active'
  canSelfServe: boolean
  url: string
}): Omit<EmailMessage, 'to'> {
  const lost = input.event === 'lost'

  const why = !lost
    ? 'Their subscription is paid up, and they have been told.'
    : input.reason === 'past_due'
      ? 'A subscription payment was declined, so they cannot create appointments until it is paid.'
      : 'Their subscription has ended, so they cannot create appointments until it is restarted.'

  const action = !lost
    ? null
    : input.canSelfServe
      ? 'They can fix this themselves in the Stripe billing portal from their Membership page, and they have been emailed a link to it. Nothing is needed from you unless they ask.'
      : 'They have no billing account on file, so they CANNOT fix this themselves — this one needs you.'

  return {
    subject: lost
      ? `Booking paused: ${input.providerName}`
      : `Booking restored: ${input.providerName}`,
    text: [
      lost
        ? `${input.providerName} has lost the ability to book.`
        : `${input.providerName} can book again.`,
      '',
      why,
      ...(action ? ['', action] : []),
      '',
      'Providers:',
      input.url,
    ].join('\n'),
    html: wrap(
      lost ? 'A provider cannot book' : 'A provider can book again',
      p(`<strong>${input.providerName}</strong>`) + p(why) + (action ? p(action) : ''),
      { label: 'Open the provider roster', url: input.url },
    ),
  }
}
