import { eq } from 'drizzle-orm'

import { getCurrentUser } from '@/lib/auth/dal'
import { isAdmin } from '@/lib/auth/roles'
import { readReceipt } from '@/lib/blob'
import { db } from '@/lib/db'
import { bookings } from '@/lib/db/schema'

// Serving a receipt.
//
// NOT the coarse any-signed-in-provider rule the equipment photo route uses, and the difference
// is the whole reason this is a separate route rather than a parameter on that one.
//
// An equipment photo is of a shared machine everybody is jointly accountable for — a fault one
// person reported is a fault the next person walks into, so any provider may see any of them. A
// receipt is a document about somebody's CLIENT, and the rental terms promise that Melanite
// keeps no record of who those are. Two people have any business with it: the provider who sent
// it, and Keoni, who has to set a figure from it.
//
// Everything else is the same discipline as that route: the storage key comes from the database
// and never from the URL, so this cannot be a path-traversal question; a 401 rather than a
// redirect, because an <img> following a 307 to a login page renders as a broken image with no
// clue why.

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ bookingId: string }> },
) {
  const user = await getCurrentUser()
  if (!user) return new Response('Unauthorized', { status: 401 })

  const { bookingId } = await params

  const [booking] = await db
    .select({
      providerId: bookings.providerId,
      storageKey: bookings.receiptStorageKey,
      mimeType: bookings.receiptMimeType,
    })
    .from(bookings)
    .where(eq(bookings.id, bookingId))
    .limit(1)

  if (!booking) return new Response('Not found', { status: 404 })

  // The two who may look. Admin because she sets the figure from it; the sender because it is
  // their own document and they may want to check what they sent.
  if (!isAdmin(user.role) && booking.providerId !== user.id) {
    return new Response('Forbidden', { status: 403 })
  }

  // Gone is the ORDINARY outcome here, not an error: the file is deleted once Keoni has settled
  // the session. 404 rather than 500, and the queue stops linking to it at the same moment.
  if (!booking.storageKey) return new Response('No receipt', { status: 404 })

  const file = await readReceipt(booking.storageKey)
  if (!file) return new Response('No receipt', { status: 404 })

  return new Response(file.body, {
    headers: {
      'Content-Type': booking.mimeType ?? file.contentType,
      // Never cached by a shared cache. A receipt is somebody's client's document and the
      // authorisation above is per-request; a CDN copy would outlive both.
      'Cache-Control': 'private, no-store',
      'Content-Disposition': 'inline',
    },
  })
}
