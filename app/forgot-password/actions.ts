'use server'

import { headers } from 'next/headers'

import { createResetToken } from '@/lib/auth/reset'
import { passwordResetEmail, sendEmail } from '@/lib/email'

export interface ForgotState {
  sent?: boolean
  error?: string
  /** Only ever set outside production, so the flow is testable before email is configured. */
  devLink?: string
}

export async function requestReset(_prev: ForgotState, formData: FormData): Promise<ForgotState> {
  const email = String(formData.get('email') ?? '').trim().toLowerCase()
  if (!email) return { error: 'Enter your email address.' }

  const result = await createResetToken(email)

  // Always report success. Saying "no account with that email" turns this form into a way to
  // enumerate who works here.
  if (!result) return { sent: true }

  const headerList = await headers()
  const origin =
    process.env.APP_BASE_URL ??
    `${headerList.get('x-forwarded-proto') ?? 'http'}://${headerList.get('host')}`
  const url = `${origin}/reset-password?token=${result.token}`

  try {
    const { delivered } = await sendEmail({
      to: email,
      ...passwordResetEmail(result.firstName, url),
    })

    // Without an API key the message is only logged, so surface the link locally rather than
    // pretending an email arrived. Never in production.
    if (!delivered && process.env.NODE_ENV !== 'production') {
      return { sent: true, devLink: url }
    }
  } catch (err) {
    // Log for operators, stay generic for the user — a delivery failure must not reveal
    // whether the address existed.
    console.error('[forgot-password] send failed', err)
  }

  return { sent: true }
}
