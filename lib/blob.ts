import 'server-only'

// Object storage, for the only binary this app handles: photographs of the laser.
//
// Wrapped the way `lib/email.ts` wraps Resend — one module, one place to change providers, and
// honest about being unconfigured rather than throwing somewhere surprising. `documents.storageKey`
// already committed to this shape: an opaque key in Postgres, a URL resolved at read time, so the
// file store can change without a data migration.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THIS STORE IS NOT BUILT FOR CLIENT PHOTOGRAPHS.
//
// It holds pictures of a machine. That is the only reason the trade-offs below are acceptable:
// blobs are public-with-unguessable-URLs, there is no per-object access check, no consent record,
// no retention policy and no audit of who viewed what.
//
// Once a camera button exists in a laser clinic, somebody will eventually point it at a client's
// skin. If that becomes a feature rather than an accident, this is what has to change FIRST —
// before a single such image is written, not after:
//
//   - private blobs with short-lived signed URLs, so possession of a link is not access
//   - an authorisation check on read, tied to the client the image belongs to
//   - a consent record and a retention policy, because a clinical photograph is not ours to keep
//     indefinitely
//   - a considered answer on HIPAA, which is a conversation and not a code change
//
// Naming, wording and the upload UI all say "the laser" for this reason. Keeping the drift
// obvious is cheap now and expensive to retrofit.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { del, put } from '@vercel/blob'

/** What a phone camera produces, and nothing else. No PDFs, no HEIC — Safari converts HEIC to
 *  JPEG on upload, and accepting formats we cannot render is how a broken thumbnail becomes a
 *  support message. */
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp'])

/** After client-side downscaling a photo lands around 200–400KB. This is the backstop for a
 *  client that skipped it, not the expected size — v1 allowed 10MB and that was for PDFs. */
const MAX_BYTES = 8 * 1024 * 1024

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

export interface StoredBlob {
  storageKey: string
  mimeType: string
  sizeBytes: number
}

export type BlobRefusal =
  | { ok: false; reason: 'not-configured' | 'type' | 'size' | 'empty'; detail: string }

export type BlobResult = { ok: true; blob: StoredBlob } | BlobRefusal

export function blobConfigured(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN)
}

/**
 * Stores one equipment photograph.
 *
 * VALIDATES BEFORE IT WRITES. v1's upload endpoint called `storage.create_attachment` and only
 * then checked MIME and size, so every rejected file was already persisted — a 50MB upload was
 * refused and kept. The order here is deliberate and is the whole reason this is a function
 * rather than a `put` at the call site.
 *
 * The key carries a check id and nothing else: no client name, no booking id, no provider name.
 * A storage key ends up in URLs, logs and error reports, and none of those are places to leak who
 * somebody was treating.
 */
export async function putEquipmentPhoto(
  checkId: string,
  file: { type: string; size: number; arrayBuffer(): Promise<ArrayBuffer> },
): Promise<BlobResult> {
  if (!blobConfigured()) {
    return {
      ok: false,
      reason: 'not-configured',
      detail: 'Photo storage is not set up in this environment (BLOB_READ_WRITE_TOKEN).',
    }
  }

  if (!file.size) {
    return { ok: false, reason: 'empty', detail: 'That file is empty.' }
  }

  if (!ALLOWED_MIME.has(file.type)) {
    return {
      ok: false,
      reason: 'type',
      detail: 'Photos only — JPEG, PNG or WebP.',
    }
  }

  if (file.size > MAX_BYTES) {
    return {
      ok: false,
      reason: 'size',
      detail: `That photo is ${(file.size / 1024 / 1024).toFixed(1)}MB. The limit is ${MAX_BYTES / 1024 / 1024}MB.`,
    }
  }

  const key = `equipment/${checkId}.${EXTENSIONS[file.type]}`

  const stored = await put(key, await file.arrayBuffer(), {
    access: 'public',
    contentType: file.type,
    // The key already contains a uuid, so the store must not add its own suffix — otherwise the
    // pathname we record and the pathname it saved under diverge, and the photo is unreachable.
    addRandomSuffix: false,
  })

  return {
    ok: true,
    blob: { storageKey: stored.pathname, mimeType: file.type, sizeBytes: file.size },
  }
}

/** The URL a browser can fetch.
 *
 *  A function rather than a stored column, so the record keeps holding a key and not a URL. When
 *  this moves to signed URLs — see the note at the top — only this changes, and nothing has to be
 *  migrated. */
export function equipmentPhotoUrl(storageKey: string): string {
  const base = process.env.BLOB_PUBLIC_BASE_URL?.replace(/\/$/, '')
  return base ? `${base}/${storageKey}` : storageKey
}

/** Removes a stored photo. Used when the database write fails after the upload succeeded —
 *  otherwise a refused check leaves an orphan nobody can find, since the only pointer to it was
 *  the row that never landed. */
export async function deleteEquipmentPhoto(storageKey: string): Promise<void> {
  if (!blobConfigured()) return
  try {
    await del(equipmentPhotoUrl(storageKey))
  } catch (err) {
    console.error('[blob] could not remove orphaned photo', storageKey, err)
  }
}
