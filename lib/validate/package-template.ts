// Package template rules.
//
// These live in lib rather than beside the action, and the reason is worth recording: a
// `'use server'` module may only export ASYNC functions. Exporting this validator from the
// action compiled cleanly, passed eslint, passed its own unit tests — and made every page in
// the app return 500 at runtime, because the whole module failed to build. Nothing in the
// toolchain catches it. PASSWORD_CHECKS hit the same wall earlier; pure logic that wants
// testing belongs here.

export interface TemplateLineInput {
  serviceId: string
  quantity: number
  perSessionValue: number
}

/** Money is compared in INTEGER CENTS, never as floats.
 *
 *  v1 is explicit about this: "sum(per_session_value × quantity) == total_price, compared in
 *  integer cents". With floats, 3 × 116.67 is 350.00999999999996 and a perfectly valid
 *  package is rejected — or worse, a mismatched one slips through. */
const cents = (n: number) => Math.round(n * 100)

export function validateTemplate(
  name: string,
  totalPrice: number,
  lines: TemplateLineInput[],
  offeredServiceIds: Set<string>,
): string | null {
  if (!name.trim()) return 'Give the package a name.'
  if (!Number.isFinite(totalPrice) || totalPrice <= 0) return 'Total price must be more than zero.'
  if (lines.length === 0) return 'Add at least one service.'

  // One line per service — quantity expresses multiples. v1: DUPLICATE_SERVICE_LINE.
  const ids = lines.map((l) => l.serviceId)
  if (new Set(ids).size !== ids.length) {
    return 'Each service can only appear once. Use quantity for multiples.'
  }

  for (const line of lines) {
    if (!offeredServiceIds.has(line.serviceId)) {
      return 'Every line must be a service you currently offer.'
    }
    if (!Number.isInteger(line.quantity) || line.quantity < 1) {
      return 'Each line needs a quantity of at least 1.'
    }
    if (!Number.isFinite(line.perSessionValue) || line.perSessionValue <= 0) {
      return 'Each line needs a per-session value above zero.'
    }
  }

  const sum = lines.reduce((s, l) => s + cents(l.perSessionValue) * l.quantity, 0)
  if (sum !== cents(totalPrice)) {
    const diff = ((sum - cents(totalPrice)) / 100).toFixed(2)
    return `Line items add up to ${(sum / 100).toFixed(2)}, which is ${diff} off the total. They must match exactly.`
  }

  return null
}
