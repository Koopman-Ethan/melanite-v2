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
