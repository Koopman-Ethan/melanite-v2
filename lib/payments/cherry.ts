// When Cherry is offered, and on what.
//
// Cherry is patient financing: the client applies on Cherry's site, Cherry pays Melanite in
// full, and the client repays Cherry monthly. To this app it is a HAND-OFF — there is no
// webhook, no callback, and no way to know the outcome. Everything Melanite can do is record
// that somebody went, and chase it.
//
// The rule lives here because it is now asked in three places (packages, appointments, and the
// admin chase list) and a floor that disagrees between them means a button offered on one screen
// and refused on the next.

/** Cherry's own floor for writing a plan.
 *
 *  Below this they decline, so offering the button on a $150 service sends the client to a page
 *  that turns them down — worse than not offering it, because it reads as a promise the practice
 *  could not keep. Keoni confirmed $200 for appointments on 2026-07-31; it was already the
 *  package floor. */
export const CHERRY_MINIMUM = 200

/** Should the Cherry option appear for this amount?
 *
 *  `applyUrl` is half the answer. The button is hidden entirely when Cherry is not configured —
 *  a financing button that goes nowhere is worse than no financing button, and the URL is a
 *  platform setting that starts null.
 *
 *  Takes the price as a string because that is what `money()` columns hand back, and the one
 *  thing that must not happen is a `'250.00' >= 200` comparison quietly evaluating as a string.
 */
export function cherryAvailable(applyUrl: string | null, price: string | number): boolean {
  if (!applyUrl) return false
  const amount = Number(price)
  return Number.isFinite(amount) && amount >= CHERRY_MINIMUM
}
