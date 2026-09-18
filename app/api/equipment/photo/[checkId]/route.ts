import { eq } from 'drizzle-orm'

import { getCurrentUser } from '@/lib/auth/dal'
import { readEquipmentPhoto } from '@/lib/blob'
import { db } from '@/lib/db'
import { endOfUseChecklists } from '@/lib/db/schema'

// Serving a photograph of the laser.
//
// The blob store is PRIVATE, so a browser cannot fetch one directly — reading needs the token,
// which never leaves the server. Everything goes through here, which is the point: it means a
// read can be AUTHORISED, rather than access being "whoever ended up with the link".
//
// Deliberately coarse: any signed-in provider may view any equipment photo. That is right for a
// machine everybody shares and is jointly accountable for — a fault one person reported is a fault
// the next person walks into. It would be entirely wrong for anything photographing a person,
// which is the line `lib/blob.ts` draws.
//
// Every photo reaching here now hangs off a reported fault. The before/after brackets that used to
// produce most of them were dropped on 2026-09-17.
//
// Second only to authentication: nothing here is derived from user input except the id, which is
// looked up rather than used to build a path. A route that took a storage key in the URL would be
// a path-traversal question; this one cannot be, because the key comes from the database.

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ checkId: string }> },
) {
  // Not `requireProvider()` — that redirects to /login, and an <img> following a 307 to an HTML
  // page renders as a broken image with no clue why. A 401 is at least legible in the network tab.
  const user = await getCurrentUser()
  if (!user) return new Response('Unauthorized', { status: 401 })

  const { checkId } = await params

  const [check] = await db
    .select({ storageKey: endOfUseChecklists.photoStorageKey, mimeType: endOfUseChecklists.photoMimeType })
    .from(endOfUseChecklists)
    .where(eq(endOfUseChecklists.id, checkId))
    .limit(1)

  // No row, or a close-out that reported nothing and so carries no image. Both are a 404: the
  // difference is not the caller's business and saying which would confirm the id exists.
  if (!check?.storageKey) return new Response('Not found', { status: 404 })

  const photo = await readEquipmentPhoto(check.storageKey)

  // A row whose object is missing. Happens legitimately in dev, where rows are copied down from
  // production but the bytes were written under a different key prefix — so it is a broken
  // thumbnail rather than anything alarming.
  if (!photo) return new Response('Photo unavailable', { status: 404 })

  return new Response(photo.body, {
    headers: {
      'Content-Type': check.mimeType ?? photo.contentType,
      // Private: cached by the browser that asked, never by a shared cache. The photo is behind
      // an auth check and a CDN copy would hand it to whoever asked next.
      'Cache-Control': 'private, max-age=3600',
      'Content-Disposition': 'inline',
    },
  })
}
