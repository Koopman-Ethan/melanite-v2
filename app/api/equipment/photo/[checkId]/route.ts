import { eq } from 'drizzle-orm'

import { getCurrentUser } from '@/lib/auth/dal'
import { readEquipmentPhoto } from '@/lib/blob'
import { db } from '@/lib/db'
import { equipmentChecks } from '@/lib/db/schema'

// Serving a photograph of the laser.
//
// The blob store is PRIVATE, so a browser cannot fetch one directly — reading needs the token,
// which never leaves the server. Everything goes through here, which is the point: it means a
// read can be AUTHORISED, rather than access being "whoever ended up with the link".
//
// Deliberately coarse: any signed-in provider may view any equipment photo. That is right for a
// machine everybody shares and is jointly accountable for — a provider should be able to see the
// state the last person left it in, and that is half the reason they take their own. It would be
// entirely wrong for anything photographing a person, which is the line `lib/blob.ts` draws.
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
    .select({ storageKey: equipmentChecks.storageKey, mimeType: equipmentChecks.mimeType })
    .from(equipmentChecks)
    .where(eq(equipmentChecks.id, checkId))
    .limit(1)

  if (!check) return new Response('Not found', { status: 404 })

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
