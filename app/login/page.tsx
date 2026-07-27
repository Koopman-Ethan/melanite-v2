import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { getCurrentUser } from '@/lib/auth/dal'

import { LoginForm } from './login-form'

export const metadata: Metadata = { title: 'Sign in · Melanite' }

export default async function LoginPage({
  searchParams,
}: {
  // searchParams is a Promise in this version of Next.
  searchParams: Promise<{ next?: string }>
}) {
  // Verified here rather than in proxy.ts. Acting on the mere presence of a cookie would
  // loop forever once it expired: bounce to /app, DAL rejects, bounce back.
  const user = await getCurrentUser()
  if (user) redirect('/app')

  const { next } = await searchParams

  return (
    <main className="flex min-h-full flex-1 items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Melanite Laser Suite</h1>
          <p className="mt-1 text-sm opacity-60">Sign in to your provider account</p>
        </div>
        <LoginForm next={next} />
      </div>
    </main>
  )
}
