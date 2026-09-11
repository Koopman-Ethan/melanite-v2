'use client'

import { useActionState } from 'react'

import { Button } from '@/components/ui/button'

import { sendDigestPreview, type DigestState } from './actions'

/**
 * Rehearses the evening digest.
 *
 * Rendered only outside production — see the guard in `page.tsx` and the matching one in the
 * action itself. On production this does not exist and the Vercel cron sends the real thing.
 */
export function DigestButton() {
  const [state, action, pending] = useActionState<DigestState, FormData>(sendDigestPreview, {})

  return (
    <form action={action} className="space-y-2">
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? 'Sending…' : 'Send tonight’s digest'}
      </Button>
      {state.success && <p className="text-xs text-success">{state.success}</p>}
      {state.error && <p className="text-xs text-critical">{state.error}</p>}
    </form>
  )
}
