'use client'

import { useState, useTransition } from 'react'

import { Button } from '@/components/ui/button'
import { Notice } from '@/components/ui/field'

import { removeEquipmentPhoto } from './actions'

/**
 * Destroys one photograph. Two taps, never one.
 *
 * Not `window.confirm`: a native dialog is the wrong weight for something irreversible, it cannot
 * say what will happen, and it reads identically to a cookie prompt. The second step spells out
 * the two halves people get wrong — the file is gone for good, and the session stays accounted
 * for — because "delete" on a compliance record reasonably sounds like it erases the record.
 */
export function RemovePhoto({ checkId }: { checkId: string }) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs text-ink-faint underline underline-offset-2 hover:text-danger"
      >
        Remove photo
      </button>
    )
  }

  return (
    <div className="mt-2 rounded-field border border-line bg-overlay p-3">
      <p className="text-xs text-ink-secondary">
        The photograph is deleted permanently. The record that this provider photographed the laser
        stays, so the session is still accounted for.
      </p>

      <label htmlFor={`why-${checkId}`} className="mt-2 block text-[11px] text-ink-faint">
        Why, briefly <span className="text-ink-disabled">Optional</span>
      </label>
      <input
        id={`why-${checkId}`}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        maxLength={300}
        placeholder="A client was in the photo"
        className="mt-1 min-h-9 w-full rounded-field border border-line-control bg-surface px-2 text-xs text-ink"
      />

      {error && (
        <div className="mt-2">
          <Notice>{error}</Notice>
        </div>
      )}

      <div className="mt-3 flex items-center gap-2">
        <Button
          size="sm"
          variant="danger"
          type="button"
          disabled={pending}
          onClick={() =>
            start(async () => {
              setError(null)
              const result = await removeEquipmentPhoto({ checkId, reason })
              if (result.error) setError(result.error)
              else setOpen(false)
            })
          }
        >
          {pending ? 'Removing…' : 'Delete the photo'}
        </Button>
        <Button size="sm" variant="ghost" type="button" onClick={() => setOpen(false)}>
          Keep it
        </Button>
      </div>
    </div>
  )
}
