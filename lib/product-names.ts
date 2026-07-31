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
