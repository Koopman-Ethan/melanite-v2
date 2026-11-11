import { eq } from 'drizzle-orm'

import { getCurrentUser } from '@/lib/auth/dal'
import { readContract } from '@/lib/blob'
import { db } from '@/lib/db'
import { roomContracts } from '@/lib/db/schema'
import { mayHandleContractFor } from '@/lib/rooms/contracts'

// Serving a signed room contract.
//
// The receipt rule, not the equipment one: a contract names a tenant and carries their signature,
// so the two people who may open it are that tenant and Keoni. The storage key comes from the
// database and never from the URL, and a 401 rather than a redirect, for the reasons the receipt
// route gives.

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser()
  if (!user) return new Response('Unauthorized', { status: 401 })

  const { id } = await params
  // A malformed id would otherwise reach Postgres as a uuid cast error and come back a 500.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    return new Response('Not found', { status: 404 })
  }

  const [contract] = await db
    .select({
      providerId: roomContracts.providerId,
      storageKey: roomContracts.storageKey,
      mimeType: roomContracts.mimeType,
    })
    .from(roomContracts)
    .where(eq(roomContracts.id, id))
    .limit(1)

  if (!contract) return new Response('Not found', { status: 404 })
  if (!mayHandleContractFor(user, contract.providerId)) {
    return new Response('Forbidden', { status: 403 })
  }

  // Missing bytes are ordinary on appdev: the row was copied down from production and the file
  // lives under production's prefix.
  const file = await readContract(contract.storageKey)
  if (!file) return new Response('No contract file', { status: 404 })

  return new Response(file.body, {
    headers: {
      'Content-Type': contract.mimeType,
      'Cache-Control': 'private, no-store',
      'Content-Disposition': 'inline',
    },
  })
}
