'use client'

import { useActionState, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Notice } from '@/components/ui/field'
import { recordEquipmentCheck, type CheckState } from './equipment-actions'

// Photographing the laser, from a phone, between clients.
//
// The whole feature depends on this being a few seconds of work. A provider with a client waiting
// will abandon anything that asks more, and an abandoned check is a session nobody can account
// for — so every decision here is about removing a step rather than adding a safeguard.

/** Longest edge after downscaling.
 *
 *  A phone photo is 3–5MB and a treatment room is the worst signal the app will ever see. At
 *  1600px a scratch, a warning light or a depleted consumable is perfectly legible and the file
 *  lands around 200–400KB — the difference between an upload that finishes while they put the
 *  phone down and one they cancel.
 *
 *  It also keeps the request inside the server action body limit, which a raw phone photo would
 *  blow straight through. */
const MAX_EDGE = 1600
const QUALITY = 0.82

/** Redraws the photo smaller, in the browser, before it is ever sent.
 *
 *  Returns the ORIGINAL file when anything goes wrong — a canvas that will not decode, an image
 *  the browser dislikes. The server validates type and size regardless, so the worst case is a
 *  slower upload rather than a lost photograph. Failing closed here would mean refusing to record
 *  a laser somebody is standing in front of. */
async function downscale(file: File): Promise<File> {
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
    if (scale === 1 && file.size < 1_000_000) return file

    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * scale)
    canvas.height = Math.round(bitmap.height * scale)

    const ctx = canvas.getContext('2d')
    if (!ctx) return file
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', QUALITY),
    )
    if (!blob) return file

    return new File([blob], 'laser.jpg', { type: 'image/jpeg' })
  } catch {
    return file
  }
}

export function EquipmentCheck({
  bookingId,
  kind,
  done,
}: {
  bookingId: string
  kind: 'before' | 'after'
  done: boolean
}) {
  const [state, action, pending] = useActionState<CheckState, FormData>(recordEquipmentCheck, {})
  const [open, setOpen] = useState(false)
  const [fileName, setFileName] = useState<string | null>(null)
  const [flagged, setFlagged] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const label = kind === 'before' ? 'Photograph the laser to start' : 'Photograph the laser before you go'

  // Shrinking happens on selection rather than on submit, so the wait overlaps with them typing
  // a note instead of following the button press.
  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setFileName(file.name)

    const smaller = await downscale(file)
    const box = new DataTransfer()
    box.items.add(smaller)
    if (fileRef.current) fileRef.current.files = box.files
  }

  if (done && !state.success) {
    return (
      <p className="mt-3 text-xs text-success">
        ✓ Laser photographed {kind === 'before' ? 'on arrival' : 'on the way out'}.
      </p>
    )
  }

  if (state.success) {
    return <p className="mt-3 text-xs text-success">{state.success}</p>
  }

  if (!open) {
    return (
      <div className="mt-3">
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          {label}
        </Button>
      </div>
    )
  }

  return (
    <form action={action} className="mt-3 space-y-3 rounded-card border border-line bg-overlay p-4">
      <input type="hidden" name="bookingId" value={bookingId} />
      <input type="hidden" name="kind" value={kind} />

      <div>
        <label
          htmlFor={`photo-${bookingId}-${kind}`}
          className="block text-xs font-medium text-ink-secondary"
        >
          {label}
        </label>
        <p className="mt-1 text-[11px] text-ink-faint">
          A picture of the machine, not of anyone. It is your record that you found it this way.
        </p>
        <input
          ref={fileRef}
          id={`photo-${bookingId}-${kind}`}
          name="photo"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          // Opens the rear camera straight away on a phone rather than a file browser. Ignored on
          // desktop, which falls back to picking a file.
          capture="environment"
          required
          onChange={onPick}
          className="mt-2 block w-full text-xs text-ink-muted file:mr-3 file:min-h-11 file:rounded-control file:border file:border-line-control file:bg-transparent file:px-3 file:text-xs file:font-bold file:text-ink-secondary"
        />
        {fileName && <p className="mt-1 text-[11px] text-ink-faint">Ready to send: {fileName}</p>}
      </div>

      <div>
        <label htmlFor={`note-${bookingId}-${kind}`} className="block text-xs font-medium text-ink-secondary">
          Anything worth saying? <span className="font-normal text-ink-faint">Optional</span>
        </label>
        <input
          id={`note-${bookingId}-${kind}`}
          name="note"
          type="text"
          maxLength={300}
          placeholder="Scratch on the left panel, handpiece cable fraying…"
          className="mt-1 min-h-11 w-full rounded-field border border-line-control bg-surface px-3 text-sm text-ink"
        />
      </div>

      <label className="flex items-start gap-2 text-xs text-ink-secondary">
        <input
          type="checkbox"
          name="needsAttention"
          checked={flagged}
          onChange={(e) => setFlagged(e.target.checked)}
          className="mt-0.5 size-4"
        />
        <span>
          Something is wrong with the laser
          <span className="block text-[11px] text-ink-faint">
            Emails Melanite straight away rather than waiting to be noticed.
          </span>
        </span>
      </label>

      {state.error && <Notice>{state.error}</Notice>}

      <div className="flex items-center gap-2">
        <Button size="sm" type="submit" disabled={pending}>
          {pending ? 'Sending…' : 'Save photo'}
        </Button>
        <Button size="sm" variant="ghost" type="button" onClick={() => setOpen(false)}>
          Not now
        </Button>
      </div>
    </form>
  )
}
