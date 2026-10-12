'use client'

import { useActionState } from 'react'

import { Button } from '@/components/ui/button'

import { settleRentNow, type DigestState } from './actions'

/**
 * Collects rent that is already due, now rather than tonight.
 *
 * Rendered IN PRODUCTION TOO, unlike the digest rehearsal beside it. That button sends an email
 * to Keoni and so must not fire from anywhere but the real nightly run; this takes money that is
 * already owed, twelve hours after the session, on the terms the provider accepted. There is
 * nothing about doing it early that needs protecting against.
 *
 * It exists because no single trigger should be load-bearing. Vercel Cron is best-effort, and on
 * Hobby both cron slots are already spent on the digest — so the sweep also rides inside the
 * digest, fires opportunistically on app page loads, and can be pulled by hand here.
 */
export function SettleButton() {
  const [state, action, pending] = useActionState<DigestState, FormData>(settleRentNow, {})

  return (
    <form action={action} className="space-y-2">
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? 'Collecting…' : 'Settle rent now'}
      </Button>
      {state.success && <p className="text-xs text-success">{state.success}</p>}
      {state.error && <p className="text-xs text-critical">{state.error}</p>}
    </form>
  )
}
