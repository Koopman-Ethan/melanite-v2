// Which way does the money travel?
//
// Every payment in Melanite ends up split between the provider and the platform, but they do
// not all START in the same place, and that decides whether anything is still owed to anybody
// once the split is recorded.
//
//   Stripe   the client pays Melanite's platform account; Stripe forwards the provider's share
//   Cherry   the client finances a package; Cherry pays MELANITE, which then owes the provider
//   Groupon  the client redeems a voucher with the PROVIDER, who then owes Melanite its half
//   cash     same
//   cheque   same
//
// Lives here rather than in the server action that uses it because a `'use server'` file may
// only export async functions. Exporting a plain constant from one compiles, passes lint, and
// breaks every page at runtime — which has happened here once already.

/** Payment methods where the client handed the money to the PROVIDER.
 *
 *  Their share never travels: they took the whole amount at the appointment and passed Melanite
 *  its half, so no payout will ever be sent and none is outstanding. Recording these as pending
 *  told a provider Melanite owed them money they were holding themselves, and the figure grew
 *  with every such appointment they took. */
export const PROVIDER_ALREADY_HOLDS: ReadonlySet<string> = new Set([
  'groupon',
  'cash',
  'check',
  'other',
])

/** True when the provider's share is genuinely still in transit and belongs in "awaiting
 *  payout" — Stripe holding it, or Melanite having collected it on their behalf. */
export function providerStillAwaitingPayout(method: string): boolean {
  return !PROVIDER_ALREADY_HOLDS.has(method)
}
