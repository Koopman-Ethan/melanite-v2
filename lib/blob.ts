import 'server-only'

// Object storage, for the only binary this app handles: photographs of the laser.
//
// Wrapped the way `lib/email.ts` wraps Resend — one module, one place to change providers, and
// honest about being unconfigured rather than throwing somewhere surprising. `documents.storageKey`
// already committed to this shape: an opaque key in Postgres, a URL resolved at read time, so the
// file store can change without a data migration.
//
// The store is PRIVATE. Blobs cannot be fetched with a URL alone — reading one needs the token,
// which lives only on the server. Photos therefore reach a browser through
// `/api/equipment/photo/[checkId]`, which checks who is asking before it streams anything.
//
// That is better than the unguessable-public-URL arrangement this was first written for, and it
// removes a whole class of "the link leaked" problem. It also means there is no public base URL
// to configure, and no silent failure mode where uploads succeed while every thumbnail breaks.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THIS STORE IS STILL NOT BUILT FOR CLIENT PHOTOGRAPHS.
//
// Private access and an authenticated read are two of the four things that would be needed, and
// they are now done. The remaining two are not, and they are the harder ones:
//
//   - a consent record and a retention policy, because a clinical photograph is not ours to keep
//     indefinitely, and nothing here expires or is auditable
//   - a considered answer on HIPAA, which is a conversation and not a code change
//
// Read access is also coarse: any signed-in provider may view any equipment photo, which is
// right for a shared machine everybody is accountable for and wrong for anything about a person.
//
// Naming, wording and the upload UI all say "the laser" for this reason. Keeping the drift
// obvious is cheap now and expensive to retrofit.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { del, get, put } from '@vercel/blob'

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
  | {
      ok: false
      reason: 'not-configured' | 'type' | 'size' | 'empty' | 'upload-failed'
      detail: string
    }

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

  const key = `${keyPrefix()}${checkId}.${EXTENSIONS[file.type]}`

  // Wrapped, because everything else in this function reports a refusal by RETURNING one and the
  // caller renders `detail` to the provider. An escaping throw would be the one failure mode that
  // reaches her as a crashed page instead of a sentence — and it is also the likeliest one, since
  // this runs on a phone in a treatment room where the signal is bad and the store can rate-limit
  // or time out. A photo that failed to send is a retry, not an incident.
  let stored: Awaited<ReturnType<typeof put>>
  try {
    stored = await put(key, await file.arrayBuffer(), {
      // Must match the store. An earlier version of this passed 'public' on the theory that the
      // per-object setting was a separate knob from the store's; it is not, and the SDK refuses
      // outright: "Cannot use public access on a private store."
      access: 'private',
      contentType: file.type,
      // The key already contains a uuid, so the store must not add its own suffix — otherwise the
      // pathname we record and the pathname it saved under diverge, and the photo is unreachable.
      addRandomSuffix: false,
    })
  } catch (err) {
    console.error('[blob] upload failed for', key, err)
    return {
      ok: false,
      reason: 'upload-failed',
      detail: 'That photo did not upload — check your signal and try again.',
    }
  }

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
/** Where photos taken in THIS environment are filed.
 *
 *  One store serves production and appdev, because two would mean two variables of the same name
 *  and a per-environment lookup that is easy to get subtly wrong. The prefix is what keeps test
 *  uploads visibly apart from photographs of the actual machine — without it they are
 *  indistinguishable uuids mixed together, and a sweep of one would risk the other. */
function keyPrefix(): string {
  return process.env.MELANITE_ENV === 'prod' ? 'equipment/' : 'equipment/dev/'
}

/** The URL a browser fetches. Our own route, not the blob store's.
 *
 *  The store is private, so a direct URL would 403 — and routing through the app is what lets a
 *  read be authorised at all. The record still holds a key rather than a URL, so where the bytes
 *  live can change without migrating anything. */
export function equipmentPhotoUrl(checkId: string): string {
  return `/api/equipment/photo/${checkId}`
}

/** Fetches the bytes, server-side, with the token. Used only by the route above.
 *
 *  Returns null rather than throwing when the object is gone: a photo missing from the store is
 *  a broken thumbnail, not a broken page, and it happens legitimately in dev where rows are
 *  copied down from production but the objects were written under a different prefix. */
export async function readEquipmentPhoto(
  storageKey: string,
): Promise<{ body: ReadableStream<Uint8Array>; contentType: string } | null> {
  if (!blobConfigured()) return null

  try {
    // `get`, not `head` plus a plain fetch. head() hands back a URL, and on a PRIVATE store
    // fetching that URL without the token is refused — which showed up as every thumbnail
    // 404ing while the upload had plainly succeeded. This reads the bytes with the token.
    const result = await get(storageKey, { access: 'private' })
    if (!result?.stream) return null

    return {
      body: result.stream as ReadableStream<Uint8Array>,
      contentType: result.blob.contentType ?? 'application/octet-stream',
    }
  } catch {
    return null
  }
}

/** Does this key belong to the environment asking to delete it?
 *
 *  The load-bearing guard in this module. Dev's database is a COPY of production, so a check row
 *  on appdev points at the production photograph — the real one, of the real machine. An
 *  environment-blind delete button would let a test click on appdev destroy it, and blobs do not
 *  come back.
 *
 *  Prefix ownership, not an environment flag: production owns `equipment/` except the dev subtree,
 *  and everything else owns `equipment/dev/`. Each can only ever reach its own. */
export function ownsStorageKey(storageKey: string): boolean {
  const isDevKey = storageKey.startsWith('equipment/dev/')
  return process.env.MELANITE_ENV === 'prod' ? !isDevKey : isDevKey
}

export type DeleteResult =
  | { ok: true }
  | { ok: false; reason: 'not-configured' | 'foreign' | 'failed'; detail: string }

/** Destroys the bytes. Permanent — there is no undo and no copy.
 *
 *  Used for two things: cleaning up an object whose database row failed to write, and Melanite
 *  removing a photograph that should not have been taken. Never for saving space; at roughly half
 *  a gigabyte a year that is not a problem worth a delete button.
 *
 *  The CHECK ROW is never removed by this — see `equipmentChecks.photoDeletedAt`. Deleting the row
 *  would turn a provider who photographed the laser into one who did not. */
export async function deleteEquipmentPhoto(storageKey: string): Promise<DeleteResult> {
  if (!blobConfigured()) {
    return { ok: false, reason: 'not-configured', detail: 'Photo storage is not set up here.' }
  }

  if (!ownsStorageKey(storageKey)) {
    // Refused rather than thrown, and logged loudly: this means a row is pointing at another
    // environment's object, which on appdev is normal and expected after a copy-down.
    console.warn('[blob] refusing to delete', storageKey, '— it belongs to another environment')
    return {
      ok: false,
      reason: 'foreign',
      detail: 'That photo belongs to a different environment and cannot be deleted from here.',
    }
  }

  try {
    await del(storageKey)
    return { ok: true }
  } catch (err) {
    console.error('[blob] could not remove photo', storageKey, err)
    return { ok: false, reason: 'failed', detail: 'The photo could not be removed. Try again.' }
  }
}
