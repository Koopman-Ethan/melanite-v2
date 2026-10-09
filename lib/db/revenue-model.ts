import 'server-only'

import { sql, type SQL } from 'drizzle-orm'

// The SQL half of `lib/revenue-model.ts`.
//
// Separate file because that one has no runtime imports on purpose — it is reachable from client
// components via `lib/nav.ts` — and these need drizzle's `sql`. Same reasoning, opposite
// constraint: this module is server-only.
//
// Use these anywhere a query filters on the billing model. A hand-written `<> 'house'` in a
// query is the same latent bug the predicates exist to prevent, and it is worse here because a
// wrong SQL predicate silently returns the wrong ROWS rather than failing.
//
// `providers` is not aliased in every query that needs this, so each fragment takes the table
// reference it should qualify. Pass a raw alias with `sql.raw` where the query uses one.

/** Providers who owe a flat rental fee. See `paysRent`. */
export function paysRentSql(column: SQL | unknown): SQL {
  // TODO(hybrid): becomes `= 'rental'` when the value is added. Written as the negation today so
  // this commit is provably behaviour-preserving — every call site it replaces said exactly this.
  return sql`${column} <> 'house'`
}

/** Providers on the original revenue share. See `sharesRevenue`. */
export function sharesRevenueSql(column: SQL | unknown): SQL {
  return sql`${column} <> 'house'`
}

/** Melanite's own account. */
export function isHouseSql(column: SQL | unknown): SQL {
  return sql`${column} = 'house'`
}

/**
 * Anybody who is not Melanite itself, whichever model they are on.
 *
 * A GENUINELY DIFFERENT QUESTION from the two above, and the reason this fragment exists rather
 * than being folded into one of them. Some rules are about which billing model applies; this one
 * is about Melanite not invoicing itself, and it has to keep holding for a provider who has since
 * moved models.
 *
 * `getOwedByProvider` is the case that proves it. It totals what Keoni collects on `external`
 * bookings at the old split, and the thirteen pre-cutover ones belong to Nichole and janea — who
 * move to rent. Narrowing it to `sharesRevenueSql` would drop their rows and quietly understate
 * what she is owed, which is the failure mode this whole module exists to prevent, achieved by
 * being too clever rather than not clever enough.
 */
export function notHouseSql(column: SQL | unknown): SQL {
  return sql`${column} <> 'house'`
}
