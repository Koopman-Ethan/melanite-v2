'use server'

import { redirect } from 'next/navigation'

import { consumeResetToken, validatePassword } from '@/lib/auth/reset'

export interface ResetState {
  error?: string
}

export async function setNewPassword(_prev: ResetState, formData: FormData): Promise<ResetState> {
  const token = String(formData.get('token') ?? '')
  const password = String(formData.get('password') ?? '')
  const confirm = String(formData.get('confirm') ?? '')

  if (password !== confirm) return { error: 'Those passwords do not match.' }

  const problem = validatePassword(password)
  if (problem) return { error: problem }

  const ok = await consumeResetToken(token, password)
  if (!ok) {
    return {
      error: 'This link has expired or already been used. Request a new one.',
    }
  }

  // Every session was revoked, so they sign in fresh with the new password. Signing them in
  // here would be friendlier but would skip proving they can use what they just set.
  redirect('/login?reset=1')
}
