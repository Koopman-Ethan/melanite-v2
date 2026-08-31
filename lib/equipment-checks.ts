// When an equipment photograph is worth asking for.
//
// Pure logic, no database — so it can be tested directly, which matters more here than anywhere
// else in this feature. Get it wrong in one direction and providers are nagged for something
// genuinely redundant, which is how people learn to dismiss the prompt; get it wrong in the other
// and the one bracket that mattered is silently never asked for.

/** How long a gap after an appointment before the laser counts as "left alone".
 *
 *  Three hours because the next provider's arrival photograph is what brackets the previous
 *  session, and that only holds if they turn up while the machine is plausibly untouched. A
 *  fifteen-minute gap between back-to-back appointments needs no second photograph; an afternoon
 *  does. */
export const UNATTENDED_GAP_MINUTES = 180

export interface LaserSlot {
  id: string
  startTime: Date
  endTime: Date
}

/**
 * Does this booking need an "after" photograph?
 *
 * TRUE when nobody follows closely enough for their arrival photo to bracket this session:
 * the last booking on the laser that day, or a gap longer than `UNATTENDED_GAP_MINUTES`.
 *
 * FALSE when another booking starts soon after, because that provider's before-photo already
 * records the state this one left the machine in. Asking anyway costs a provider time to produce
 * a photograph nothing will ever be compared against.
 *
 * `sameDay` is every booking on the laser that day INCLUDING this one, in any order — the laser
 * is shared platform-wide, so "who follows me" is not a question about one provider's calendar.
 */
export function afterCheckNeeded(booking: LaserSlot, sameDay: readonly LaserSlot[]): boolean {
  const next = sameDay
    .filter((b) => b.id !== booking.id && b.startTime >= booking.endTime)
    .sort((a, b) => a.startTime.getTime() - b.startTime.getTime())[0]

  return afterNeededGiven(booking.endTime, next?.startTime ?? null)
}

/**
 * The same rule, given only when the next use of the laser starts.
 *
 * The threshold lives here once. The appointments list gets `nextStart` from a correlated
 * subquery because it cannot hold a whole day in memory; the dashboard gets it from the day it
 * already loaded. Two ways of answering "who follows me", one definition of how long a gap has
 * to be — which is the half that would otherwise drift.
 */
export function afterNeededGiven(endTime: Date, nextStart: Date | null): boolean {
  if (!nextStart) return true
  return (nextStart.getTime() - endTime.getTime()) / 60_000 > UNATTENDED_GAP_MINUTES
}

/** Is this booking one a provider should be photographing around right now?
 *
 *  Deliberately not "is it today". A provider arriving for a 9am appointment should be prompted
 *  when they arrive, not from midnight; and an appointment that finished an hour ago is still
 *  worth an after-photo. The window is generous on both sides because the alternative — a prompt
 *  that vanishes at an arbitrary moment — is worse than one that lingers.
 */
export function checkWindowOpen(booking: LaserSlot, now: Date = new Date()): boolean {
  const opensAt = booking.startTime.getTime() - 60 * 60_000
  const closesAt = booking.endTime.getTime() + 12 * 60 * 60_000
  return now.getTime() >= opensAt && now.getTime() <= closesAt
}

/** A session nobody can account for.
 *
 *  A past booking that was actually used — `upcoming` or `completed`, the same pair the laser's
 *  overlap constraint treats as occupying — with no arrival photograph. Cancelled and no-show
 *  appointments never touched the machine and are not gaps.
 *
 *  This is the thing worth surfacing to Keoni, and it can never be repaired: once somebody else
 *  has used the laser, a photograph taken now shows a state this provider did not leave it in.
 */
export function isUnbracketed(input: {
  status: string
  endTime: Date
  hasBefore: boolean
  now?: Date
}): boolean {
  const now = input.now ?? new Date()
  if (input.status !== 'upcoming' && input.status !== 'completed') return false
  if (input.endTime > now) return false
  return !input.hasBefore
}
