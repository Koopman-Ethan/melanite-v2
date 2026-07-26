# Xano → Neon ETL

Small-data migration. The Phase 5 plan assumed CSV exports, staging tables and `psql \copy`;
the real dataset is **13 bookings and 10 payment intents**, so this is a single TypeScript
transform instead. No staging layer.

## Shape

```
staged/          JSON snapshots, committed so a run is reproducible and reviewable
  xano/*.json    one file per Xano table, pulled via the read-only MCP
  stripe/*.json  payment intents, refunds, subscriptions, invoices
transform.ts     pure functions: staged rows -> v2 rows. No I/O, unit-testable.
load.ts          runs transform, inserts via Drizzle, in FK-safe order
verify.ts        reconciles the loaded ledger against Stripe
```

Run: `npx tsx scripts/etl/load.ts` then `npx tsx scripts/etl/verify.ts`.

## Rules this transform encodes

These are the findings from `docs/v1-spec/`. They are the reason this is a transform and not
a copy.

**1. Tips are normalized.** v1's two ledgers disagree:

| source | v1 `gross_amount` | |
|---|---|---|
| `transactions` | **excludes** tip | `/admin/revenue` adds it back as `gross_w_tip` |
| `package_transactions` | **includes** tip | adding `tip_amount` would double-count |

v2 convention: **`grossAmount` excludes tip; `tipAmount` is separate.** Package rows must have
their tip subtracted out of gross on import.

**2. Refunds come from Stripe, not from v1.** `transactions` has no refund rows and never
will — the platform webhook's `charge.refunded` branch only handles training enrollments. Both
live refunds are reconstructed from the Stripe API.

**3. Refunds do not reverse the provider transfer.** Verified: `transfer_reversal: null` on the
one booking refund. So a refund entry is `providerPayout = 0`, `melaniteCut = −(full refund)` —
the platform absorbs all of it. This deliberately breaks the `cut + payout == gross + tip`
invariant that holds for purchases.

**4. Provider-paid revenue is unsplit.** Room rental and membership: `payer = 'provider'`,
`providerPayout = 0`, `melaniteCut = grossAmount`. Enforced by a check constraint in the schema.

**5. Membership revenue exists only in Stripe.** No Xano table holds it. Built from invoices,
joined to providers via `metadata.provider_id` (present on both subscription and line item).

**6. Timestamps are epoch milliseconds.** `created_at: 1784753631212`. Every Xano timestamp
needs `new Date(ms)`.

**7. Passwords are not portable.** Xano's HMAC keying is undocumented. Providers import with
`passwordHash: null` and `requiresPasswordReset: true`.

**8. Clients are deduped on lowercased email**, falling back to phone, then to a per-booking
synthetic identity. v1 has no client entity.

## Reconciliation target

`verify.ts` asserts the loaded ledger reproduces this, derived from Stripe (10 PIs, complete).
**Both columns are net of refunds** — $2,227.25 was collected gross, $77.25 refunded.

| source | net gross | platform keeps |
|---|---|---|
| booking | $150.00 | $52.75 | 2 purchases ($150.00 + $17.25), one fully refunded |
| membership | $600.00 | $600.00 | 4 × $150, unsplit |
| training | $1,400.00 | $1,400.00 | 1 enrollment: $500 deposit + $900 balance |
| room_rental | $0.00 | $0.00 | $60.00 rental, fully refunded |
| package | $0.00 | $0.00 | not live |
| **total** | **$2,150.00** | **$2,052.75** | |

For contrast, v1's `/admin/revenue` reports **$62.50** — it reads one ledger holding one row.

## Known data-quality cases

Volume is trivial here; edge cases are the actual work.

- **Legacy manual bookings.** At least one $0 booking annotated *"Manual booking — prepaid via
  legacy package (old package structure)"*. Predates the current package tables, so it has no
  redemption to link. Imports as `paymentSource: 'comped'` with the note preserved.
- **A booking payment with no ledger row** (`pi_3TqmnZ`, $17.25). The ledger entry is built
  from Stripe, not from `transactions`.
- **`stripe_transfer_id` is never populated** — null on the one real row, even though
  `payout_status` was swept to `paid`.
- **Training enrollments have no provider** until the student becomes one; `providerId` is
  nullable on both the enrollment and its ledger entries.
