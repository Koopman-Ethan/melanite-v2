import type { SessionUser } from '@/lib/auth/session'

/**
 * Has Melanite cleared this person to rent the daily room?
 *
 * For a laser provider it is `bookingEnabled`, as it always was: the flag Keoni flips once their
 * documents are confirmed. For somebody who ONLY rents a room it cannot be: that flag is the laser
 * gate, `setPracticeType('room_only')` turns it off, and a room tenant who needed it on would be
 * handed the laser as the price of booking a room. Finishing setup is their clearance, and
 * `roomRentalEnabled` — checked separately — is Keoni's say on the room itself.
 */
export function clearedForRoom(
  user: Pick<SessionUser, 'practiceType' | 'bookingEnabled' | 'status'>,
): boolean {
  return user.practiceType === 'room_only' ? user.status === 'active' : user.bookingEnabled
}
