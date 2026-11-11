'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { upload } from '@vercel/blob/client'

import { Notice } from '@/components/ui/field'
import {
  CONTRACT_MAX_BYTES,
  CONTRACT_MIME,
  CONTRACT_TYPES_SENTENCE,
  contractTooBigMessage,
} from '@/lib/rooms/contract-file'
import { downscaleImage } from '@/lib/uploads'

import { contractUploadPathAction, recordContractAction } from './contract-actions'

/**
 * The button that puts a signed contract on file for one tenant.
 *
 * The same control for the tenant on their own page and for Keoni on Rooms; `providerId` is whose
 * contract it is, and the server decides whether the person pressing may send it.
 *
 * Three steps, because the file is too large for a server action: ask the server where it goes,
 * send it straight to the file store, then tell the server it is there — which checks before it
 * believes it. A failure at any step leaves nothing on file and says so.
 */
export function ContractUpload({
  providerId,
  label,
  quiet = false,
}: {
  providerId: string
  label: string
  /** A text link rather than a button, for the dense rows of Keoni's Rooms page. */
  quiet?: boolean
}) {
  const router = useRouter()
  const picker = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  async function send(picked: File) {
    setError(null)
    setDone(false)

    if (!(picked.type in CONTRACT_MIME) && !picked.type.startsWith('image/')) {
      setError(CONTRACT_TYPES_SENTENCE)
      return
    }

    setBusy('Preparing…')
    try {
      // A phone photo of a page is redrawn smaller and as a JPEG (which is also what turns an
      // iPhone's HEIC into something the store accepts). A PDF passes through untouched.
      const file = await downscaleImage(picked)
      if (!(file.type in CONTRACT_MIME)) {
        setError(CONTRACT_TYPES_SENTENCE)
        return
      }
      if (file.size > CONTRACT_MAX_BYTES) {
        setError(contractTooBigMessage(file.size))
        return
      }

      const place = await contractUploadPathAction(providerId, file.type)
      if ('error' in place) {
        setError(place.error)
        return
      }

      setBusy('Uploading…')
      await upload(place.pathname, file, {
        access: 'private',
        handleUploadUrl: '/api/room-contract/upload',
        contentType: file.type,
        onUploadProgress: ({ percentage }) => setBusy(`Uploading… ${Math.round(percentage)}%`),
      })

      setBusy('Saving…')
      const saved = await recordContractAction(place.pathname)
      if ('error' in saved) {
        setError(saved.error)
        return
      }
      setDone(true)
      router.refresh()
    } catch (err) {
      console.error('[contract] upload failed', err)
      setError('That did not upload. Check your connection and try again.')
    } finally {
      setBusy(null)
      if (picker.current) picker.current.value = ''
    }
  }

  return (
    <span className={quiet ? 'inline-flex flex-col gap-1' : 'flex flex-col gap-2'}>
      <input
        ref={picker}
        type="file"
        accept="application/pdf,image/*"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) void send(file)
        }}
      />
      <button
        type="button"
        disabled={busy !== null}
        onClick={() => picker.current?.click()}
        className={
          quiet
            ? 'self-start text-xs text-gold underline underline-offset-2 disabled:opacity-60'
            : 'self-start rounded-field border border-gold bg-gold/10 px-3 py-2 text-sm text-gold transition-colors hover:bg-gold/20 disabled:opacity-60'
        }
      >
        {busy ?? label}
      </button>
      {error && <Notice>{error}</Notice>}
      {done && !error && <span className="text-xs text-ink-muted">Uploaded.</span>}
    </span>
  )
}
