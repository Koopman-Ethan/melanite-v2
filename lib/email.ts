import 'server-only'

// Email delivery. v1 used Resend, so this keeps that provider rather than introducing
// another account to manage.
//
// With no RESEND_API_KEY configured, messages are logged to the server console instead of
// sent. That is deliberate for development, but it means a reset link on a machine without
// the key goes nowhere visible to the recipient — hence the loud warning. It must not fail
// silently, because "the email never arrived" is indistinguishable from a broken flow.

const RESEND_ENDPOINT = 'https://api.resend.com/emails'

export interface EmailMessage {
  to: string
  subject: string
  html: string
  text: string
}

export async function sendEmail(message: EmailMessage): Promise<{ delivered: boolean }> {
  const apiKey = process.env.RESEND_API_KEY
  const from = process.env.RESEND_FROM ?? 'Melanite Laser Suite <noreply@melanitesuite.com>'

  if (!apiKey) {
    console.warn(
      `\n[email] RESEND_API_KEY is not set — NOT SENT.\n` +
        `  to:      ${message.to}\n` +
        `  subject: ${message.subject}\n` +
        `  ${message.text.replace(/\n/g, '\n  ')}\n`,
    )
    return { delivered: false }
  }

  const res = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to: message.to, subject: message.subject, html: message.html, text: message.text }),
  })

  if (!res.ok) {
    // Surface the provider's reason; the caller decides whether to expose anything to the
    // user, which for a reset flow it should not.
    throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }

  return { delivered: true }
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
