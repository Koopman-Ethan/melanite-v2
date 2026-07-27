import type { Metadata } from 'next'
import Link from 'next/link'

import { findResetTokenOwner } from '@/lib/auth/reset'

import { ResetForm } from './reset-form'

export const metadata: Metadata = { title: 'Set a new password · Melanite' }

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>
}) {
  const { token } = await searchParams

  // Validated before rendering the form, so an expired link says so immediately rather than
  // after someone has typed a password twice.
  const owner = token ? await findResetTokenOwner(token) : null

  return (
    <main className="flex min-h-full flex-1 items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm">
        {owner ? (
          <>
            <div className="mb-8 text-center">
              <h1 className="text-2xl font-semibold tracking-tight">Set a new password</h1>
              <p className="mt-1 text-sm text-ink-muted">for {owner.email}</p>
            </div>
            <ResetForm token={token!} />
          </>
        ) : (
          <div className="space-y-4 text-center">
            <h1 className="text-2xl font-semibold tracking-tight">Link expired</h1>
            <p className="text-sm text-ink-muted">
              Password reset links last one hour and can only be used once.
            </p>
            <Link
              href="/forgot-password"
              className="inline-block rounded-control bg-gold px-[18px] py-3 text-[13px] font-bold tracking-[0.3px] text-gold-ink transition-all hover:bg-gold-hover"
            >
              Request a new link
            </Link>
          </div>
        )}
      </div>
    </main>
  )
}
