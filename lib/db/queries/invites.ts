import 'server-only'

import { desc, eq, sql } from 'drizzle-orm'

import { db } from '@/lib/db'
import { inviteLinks, providers } from '@/lib/db/schema'

// Provider invites.
//
// There is no self-service signup and there should not be: a provider is someone Keoni has met,
// usually through a training course. An invite is the only way into the system, which is why the
// table has existed since the first migration — it just had nothing driving it.

/** Seven days, matching what the v1 onboarding page tells people ("invites expire 7 days after
 *  they're sent"). Changing it means changing that copy too. */
export const INVITE_TTL_DAYS = 7

export type InviteState = 'valid' | 'not_found' | 'expired' | 'accepted' | 'revoked'

export interface InviteRow {
  id: string
  email: string
  status: string
  sentAt: Date
  expiresAt: Date
  acceptedAt: Date | null
  invitedBy: string | null
  /** True once the deadline has passed, regardless of what `status` says. */
  isExpired: boolean
}

export async function getInvites(limit = 30): Promise<InviteRow[]> {
  const rows = await db
    .select({
      id: inviteLinks.id,
      email: inviteLinks.email,
      status: inviteLinks.status,
      sentAt: inviteLinks.sentAt,
      expiresAt: inviteLinks.expiresAt,
      acceptedAt: inviteLinks.acceptedAt,
      invitedBy: sql<
        string | null
      >`(select p.first_name || ' ' || p.last_name from providers p where p.id = ${inviteLinks.invitedByAdminId})`,
    })
    .from(inviteLinks)
    .orderBy(desc(inviteLinks.sentAt))
    .limit(limit)

  const now = new Date()
  return rows.map((r) => ({ ...r, isExpired: r.status === 'pending' && r.expiresAt < now }))
}

export interface InviteLanding {
  state: InviteState
  email?: string
  expiresAt?: Date
}

/** Resolves a token for the public onboarding landing page.
 *
 *  Expiry is evaluated on read rather than written back. v1's equivalent flipped the row's
 *  status during a GET, which turns looking at a page into a write and makes a link's state
 *  depend on whether anyone happened to open it.
 *
 *  Returns only the invited email and deadline — never who invited them, never an id. A token
 *  is a bearer credential and this endpoint is public.
 */
export async function getInviteLanding(token: string): Promise<InviteLanding> {
  if (!token.trim()) return { state: 'not_found' }

  const [row] = await db
    .select({
      email: inviteLinks.email,
      status: inviteLinks.status,
      expiresAt: inviteLinks.expiresAt,
    })
    .from(inviteLinks)
    .where(eq(inviteLinks.token, token))
    .limit(1)

  if (!row) return { state: 'not_found' }
  if (row.status === 'accepted') return { state: 'accepted', email: row.email }
  if (row.status === 'expired') return { state: 'revoked', email: row.email }
  if (row.expiresAt < new Date()) {
    return { state: 'expired', email: row.email, expiresAt: row.expiresAt }
  }

  return { state: 'valid', email: row.email, expiresAt: row.expiresAt }
}

/** True when someone already has an account with this email. */
export async function providerExists(email: string): Promise<boolean> {
  const [row] = await db
    .select({ id: providers.id })
    .from(providers)
    .where(eq(providers.email, email))
    .limit(1)

  return Boolean(row)
}
