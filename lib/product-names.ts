// What Melanite's paid offerings are CALLED, as opposed to what they are keyed on.
//
// The ledger, the Stripe product and the `epicutis` enum value all keep their original
// identifiers — renaming those would mean a migration, a rewrite of historical rows, and a
// mismatch with Stripe's own dashboard, all to change a word on a screen.
//
// So the display name lives here, once. It appears on the provider's membership page, their
// earnings, and two admin screens; four copies of a product name is how one screen keeps
// calling it something the business stopped calling it a year ago.

/** The optional provider membership: monthly content, client enquiries, wholesale pricing.
 *
 *  Keyed as `epicutis` throughout the data model because that is what it was called when it was
 *  built, and what Stripe still calls the product. Melanite runs it as its own growth programme
 *  — Epicutis is the product brand whose wholesale pricing is one of the perks, not the name of
 *  the membership. */
export const GROWTH_HUB = 'Melanite Growth Hub'

/** The physician oversight subscription, which is also the laser booking gate. */
export const MEDICAL_DIRECTOR = 'Medical director'

/** How a membership's state is shown, in one vocabulary.
 *
 *  The two memberships are billed the same way and sit on the same page, so "this one is
 *  running and paid for" must not read as `Active` on one card and `Subscribed` on the other —
 *  two words for one state invites the question of what the difference is.
 *
 *  Only the states that genuinely mean the same thing live here. Each card words its own ABSENT
 *  state, because those differ: no medical director is a problem that stops somebody working,
 *  and no growth hub is simply a thing they have not bought. */
export const MEMBERSHIP_STATUS = {
  active: { label: 'Active', className: 'border-success/40 bg-success/10 text-success' },
  past_due: { label: 'Past due', className: 'border-warning/40 bg-warning/10 text-warning' },
} as const
