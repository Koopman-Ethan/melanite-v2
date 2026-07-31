import 'server-only'

import { asc, eq, ne } from 'drizzle-orm'

import { db } from '@/lib/db'
import { platformSettings, providers } from '@/lib/db/schema'

// The provider roster, for the two people who administer it.
//
// `bookingEnabled` is the manual flip at the end of onboarding — the whole setup flow ends by
// telling a provider "Melanite will enable booking once your documents are confirmed" — and
// until now nothing in the app could perform it. It was being done by hand, directly against
// the database, which is both a chore and the sort of edit that has no record of who made it.

export interface RosterRow {
  id: string
  firstName: string
  lastName: string
  email: string
  role: string
  status: string
  bookingEnabled: boolean
  roomRentalEnabled: boolean
  licenseExpiry: string | null
  medicalDirectorType: string | null
  medicalDirectorStatus: string
  practiceType: string
  roomProcedures: string[] | null
  /** Whether they were ASKED what they perform in the room, which `[]` alone cannot express —
   *  "nothing supervised" and "the question did not exist when they signed up" look identical
   *  without it, and only one of those should read as settled. */
  declared: boolean
  stripeConnected: boolean
  payoutsEnabled: boolean
}

export interface Roster {
  rows: RosterRow[]
  /** The GLOBAL room-rental switch, which is a different column on a different table from the
   *  per-provider one and defaults the opposite way. Surfaced because flipping a provider on
   *  while this is off changes nothing, and the resulting "I turned it on and it didn't work"
   *  is a genuinely hard thing to spot from the outside. */
  roomRentalGloballyOn: boolean
}

export async function getRoster(): Promise<Roster> {
  const [rows, [settings]] = await Promise.all([
    db
      .select({
        id: providers.id,
        firstName: providers.firstName,
        lastName: providers.lastName,
        email: providers.email,
        role: providers.role,
        status: providers.status,
        bookingEnabled: providers.bookingEnabled,
        roomRentalEnabled: providers.roomRentalEnabled,
        licenseExpiry: providers.licenseExpiry,
        medicalDirectorType: providers.medicalDirectorType,
        medicalDirectorStatus: providers.medicalDirectorStatus,
        practiceType: providers.practiceType,
        roomProcedures: providers.roomProcedures,
        roomProceduresDeclaredAt: providers.roomProceduresDeclaredAt,
        stripeAccountId: providers.stripeAccountId,
        payoutsEnabled: providers.stripeOnboardingComplete,
      })
      .from(providers)
      // Inactive accounts are excluded: they cannot sign in at all, so their toggles are
      // decoration. Deactivating is a different action from revoking booking access.
      .where(ne(providers.status, 'inactive'))
      .orderBy(asc(providers.lastName), asc(providers.firstName)),
    db
      .select({ roomRentalEnabled: platformSettings.roomRentalEnabled })
      .from(platformSettings)
      .where(eq(platformSettings.id, 1))
      .limit(1),
  ])

  return {
    rows: rows.map(({ stripeAccountId, roomProceduresDeclaredAt, ...rest }) => ({
      ...rest,
      stripeConnected: Boolean(stripeAccountId),
      // The timestamp itself is not shown; what the roster needs is the DIFFERENCE between
      // "told us they do nothing supervised" and "was never asked", which an empty array alone
      // cannot express. Both look like `[]`.
      declared: roomProceduresDeclaredAt !== null,
    })),
    roomRentalGloballyOn: settings?.roomRentalEnabled ?? false,
  }
}
