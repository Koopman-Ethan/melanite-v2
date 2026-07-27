import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { getCurrentUser } from '@/lib/auth/dal'

import { LoginForm } from './login-form'

export const metadata: Metadata = { title: 'Sign in · Melanite' }

export default async function LoginPage({
  searchParams,
}: {
  // searchParams is a Promise in this version of Next.
  searchParams: Promise<{ next?: string; reset?: string }>
}) {
  // Verified here rather than in proxy.ts. Acting on the mere presence of a cookie would
  // loop forever once it expired: bounce to /app, DAL rejects, bounce back.
  const user = await getCurrentUser()
  if (user) redirect('/app')

  const { next, reset } = await searchParams

  return (
    <main className="flex min-h-full flex-1 items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-[13px] font-bold tracking-[3px] text-ink">MELANITE</h1>
          <p className="mt-0.5 text-[10px] tracking-[2px] text-gold">LASER SUITE</p>
          <p className="mt-1 text-sm text-ink-muted">Sign in to your provider account</p>
        </div>
        {reset && (
          <p className="mb-4 rounded-field border border-success/30 bg-success/10 px-3 py-2.5 text-sm text-ink-secondary">
            Password updated. Sign in with your new password.
          </p>
        )}
        <LoginForm next={next} />
      </div>
    </main>
  )
}
