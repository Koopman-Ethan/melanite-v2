import type { Metadata } from 'next'
import Link from 'next/link'

import { ForgotForm } from './forgot-form'

export const metadata: Metadata = { title: 'Reset your password · Melanite' }

export default function ForgotPasswordPage() {
  return (
    <main className="flex min-h-full flex-1 items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Reset your password</h1>
          <p className="mt-1 text-sm opacity-60">
            We&rsquo;ll email you a link to set a new one.
          </p>
        </div>
        <ForgotForm />
        <p className="mt-6 text-center text-sm">
          <Link href="/login" className="opacity-60 underline-offset-4 hover:underline">
            Back to sign in
          </Link>
        </p>
      </div>
    </main>
  )
}
