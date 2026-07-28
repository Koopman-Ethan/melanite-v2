// Rows in the v1 source that must NOT reach v2, and why.
//
// Half of v1's bookings are test data — `Test`, `Test Test`, `test`, `ZZ Test Client` — left
// over from building the platform. Importing them puts fake appointments on a real calendar
// and fake names in front of a real admin.
//
// The far more important half of this file is the opposite case. The loader already dropped
// $1,632 of package transactions and three redemptions WITHOUT SAYING ANYTHING. The outcome
// happened to be right — those payment intents exist only in Stripe's test mode — but nobody
// decided it and nothing recorded it. Had one of them been a real $561 package, it would have
// vanished exactly as quietly, and the first sign would have been a client asking where their
// sessions went.
//
// So every exclusion is DECLARED and PRINTED. "The loader chose not to bring this" and "the
// loader lost this" must never look the same again.

export interface Exclusion {
  /** What is being dropped, in words an admin would recognise. */
  what: string
  reason: string
}

/**
 * Client names whose bookings are test data.
 *
 * An explicit list, deliberately, rather than a /test/i pattern. A pattern would eventually
 * eat a real client called Tessa, Preston or Contessa — and it would do so silently, on the
 * run nobody was watching. A name has to be listed here to be dropped.
 *
 * Matched case-insensitively after trimming, because v1 stored what people typed.
 */
export const TEST_CLIENT_NAMES = new Set(
  ['test', 'test test', 'zz test client', 'zz test normal', 'ethan koopman'].map((n) =>
    n.toLowerCase(),
  ),
)

/** Package templates that are test data. Everything descending from one goes with it. */
export const TEST_PACKAGE_TEMPLATE_NAMES = [/^zz test/i]

export const DECLARED_EXCLUSIONS: Exclusion[] = [
  {
    what: 'Bookings for Test, Test Test, test, ZZ Test Client, ZZ Test Normal, Ethan Koopman',
    reason:
      'Left over from building v1. 7 of its 13 bookings. Two are still `upcoming`, so importing ' +
      'them would put fake appointments on a live calendar.',
  },
  {
    what: 'Checkout links belonging to excluded bookings',
    reason:
      'A checkout link without its booking is a payment page for an appointment that does not ' +
      'exist. Cascaded rather than left to a foreign key to reject.',
  },
  {
    what: 'The ZZ TEST Carbon 3-Pack template, its 2 client packages, 2 items and 3 redemptions',
    reason:
      'v1 has exactly one package template and it is a test one named "delete me". Every ' +
      'package, item and redemption descends from it, so the whole subtree is test data.',
  },
  {
    what: '3 package transactions totalling $1,632',
    reason:
      'Their payment intents resolve in Stripe TEST mode and 404 in live — sandbox experiments ' +
      'from building the package feature. The previous loader already dropped these, but ' +
      'silently; this is the same outcome, stated.',
  },
]

/** True when a booking is test data, by client name. */
export function isTestBooking(clientName: string | null | undefined): boolean {
  return TEST_CLIENT_NAMES.has((clientName ?? '').trim().toLowerCase())
}

/** True when a package template is test data, by name. */
export function isTestPackageTemplate(name: string | null | undefined): boolean {
  return TEST_PACKAGE_TEMPLATE_NAMES.some((pattern) => pattern.test((name ?? '').trim()))
}

/**
 * What must survive, stated as loudly as what must not.
 *
 * Six real bookings, and only ONE of them has a payment recorded against it. The other five
 * include $600 across three clients who were almost certainly paid by Cherry, cash or card in
 * person — v1 simply had nowhere to record that.
 *
 * Those must import. Dropping an appointment because it looks unpaid would erase real revenue
 * history; importing it puts it in front of Keoni in admin Tools > Record a payment, which
 * exists for exactly this. Reconciled once, and the ledger is complete.
 */
export const MUST_SURVIVE = [
  'Mirela Konjuhovac — $125, the one booking with a recorded payment',
  'Jordyn Catandella — $200, no payment recorded',
  'Elizabeth Homely — $200, no payment recorded',
  'Jess War — $200, no payment recorded',
  'LaRae Saxton — $0',
]
