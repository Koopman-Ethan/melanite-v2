import type { providerRevenueModel } from '@/lib/db/schema'

// Which of Melanite's billing models a provider is on, asked as a question rather than tested
// against a string.
//
// WHY THIS EXISTS. Until October there were two models and every rental code path asked the
// same way: `revenueModel !== 'house'`. That reads as "not Melanite's own appointment" and was
// a correct way to mean "pays rent" for exactly as long as there were two values.
//
// A third value breaks all of them at once, silently and in the worst direction. Keoni's three
// grandfathered providers stay on `split`, so `!== 'house'` sweeps them into the rental
// machinery: Karly charged $30 rent for the laser AND Melanite taking $25 of her $50. That is
// the exact outcome she was afraid of, and nothing would have failed to warn us — the code
// would simply have charged twice.
//
// So the predicates are POSITIVE. `paysRent` names the thing it is actually asking about, the
// switch is exhaustive, and the `never` default means a fourth model will not compile until
// every branch has been considered. Adding a model should be a compiler error, not a surprise.
//
// NO RUNTIME IMPORTS, deliberately. `lib/nav.ts` reaches two client components
// (`components/app-shell/{mobile-nav,nav-links}.tsx`) and needs these predicates, so anything
// runtime here would be bundled for the browser. The `import type` above is erased at compile
// time, which keeps the enum as the single source of truth and costs nothing. The SQL
// counterparts live in `lib/db/revenue-model.ts`, which is server-only for the same reason.

/** The enum, by reference rather than retyped, so the two cannot drift. */
export type RevenueModel = (typeof providerRevenueModel)['enumValues'][number]

/**
 * Pays Melanite a flat rental fee for laser time, and bills their own client themselves.
 *
 * The new model, and the default for everybody onboarded from October onward.
 */
export function paysRent(model: RevenueModel): boolean {
  switch (model) {
    case 'rental':
      return true
    // The three grandfathered providers. They owe Melanite a share of what they charge their
    // client, not a fee for the laser — so every rental gate has to let them through untouched.
    // Charging them here would be charging twice.
    case 'split':
      return false
    case 'house':
      return false
    default:
      return assertNever(model)
  }
}

/**
 * Keeps a share of what their client pays, with Melanite taking the rest.
 *
 * The original model. From October it is only Leyla, Brittany and Karly — grandfathered because
 * Keoni judged she would lose them otherwise. Nobody new is ever put on it.
 *
 * The mirror image of `paysRent`, and the two are now genuinely disjoint: no provider is ever
 * on both, and a provider on neither is Melanite itself.
 */
export function sharesRevenue(model: RevenueModel): boolean {
  switch (model) {
    case 'split':
      return true
    case 'rental':
      return false
    case 'house':
      return false
    default:
      return assertNever(model)
  }
}

/**
 * Melanite treating Melanite's own client. There is no rent to pay yourself and no share to
 * take from yourself, so this provider sits outside both money models.
 */
export function isHouse(model: RevenueModel): boolean {
  return model === 'house'
}

/**
 * Anybody who is not Melanite itself, whichever model they are on.
 *
 * A third question, not a convenience negation — see `notHouseSql` for the reasoning and the
 * case that proves it. Use it for rules about Melanite not transacting with itself, which must
 * keep holding for a provider who has since changed models.
 */
export function notHouse(model: RevenueModel): boolean {
  return !isHouse(model)
}

/** A short label for an admin surface. Providers never see these words. */
export function revenueModelLabel(model: RevenueModel): string {
  switch (model) {
    case 'split':
      return '50/50'
    case 'rental':
      return 'Rental'
    case 'house':
      return 'House'
    default:
      return assertNever(model)
  }
}

function assertNever(model: never): never {
  throw new Error(`unhandled revenue model: ${String(model)}`)
}
