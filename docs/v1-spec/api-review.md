# v1 backend review — 71 endpoints, 7 functions, 25 tables

Read 2026-07-26 from Xano workspace 161739 via the read-only MCP. Endpoint XanoScript is
checked in under `docs/v1-spec/api/*.xs` (8,742 lines), tables under `docs/v1-spec/schema/`.

This is a review of the backend as it stands, split into: what's wrong and worth fixing in v1
now, what's wrong but only worth fixing in v2, and what v1 got right and should be preserved.

---

## A. Money correctness — worth fixing in v1

### A1. Booking refunds never reach the ledger *(highest severity)*

`POST /webhooks/stripe/platform` is 904 lines handling six event types. Its
`charge.refunded` branch (line 734) resolves the payment intent against **`training_enrollments`
only** — it adjusts `amount_paid` / `deposit_paid` / `balance_paid` and stops there.

The single `db.add transactions` in the whole file is at line 462, inside the
`payment_intent.succeeded` branch. So:

**A refunded laser booking leaves `transactions` untouched.** `gross_amount`, `melanite_cut`
and `provider_payout` stay exactly as if the money had been kept. `/admin/revenue`,
`/admin/dashboard-summary` and `/earnings` all overstate by the full refunded amount, and
there is no later correction — the ledger is append-only, so nothing ever reconciles it.

This compounds with **BUG-21** on your backlog (`charge.refunded` not subscribed in Stripe
live). Even once you subscribe it, the branch has no code path that writes a booking refund.

Both other webhooks already do this correctly: `/webhooks/stripe/package` writes a
`type="refund"` row (line 382) and `/webhooks/stripe/room` writes three distinct refund rows
(lines 194, 221, 281). The pattern to copy exists — it just was never applied to the ledger
that carries the most money.

Worth fixing in v1 because the ledger is your revenue record of truth, and every day it runs
without this is a day of permanently unreconcilable data that then imports into v2.

### A2. The two ledgers disagree about tips

Documented in `get_platform_package_summary` and explicitly marked "DO NOT FIX":

- `transactions.gross_amount` **excludes** the tip — `/admin/revenue` computes
  `gross_w_tip = gross + tip` to compensate
- `package_transactions.gross_amount` **includes** the tip — the purchase PI is created for
  `total_price + tip` and the webhook stores `amount/100` directly

The "do not fix" call is right *for v1* — changing it now would silently move numbers Keoni
reads. But note what it costs: every consumer must remember which convention applies, and
`combined_*` in `/admin/revenue` is only correct because someone tracked this by hand.

**This is the single most important thing to get right in the v2 ETL.** Normalize to one
convention at import, or every combined figure in v2 inherits the discrepancy.

### A3. Per-service package revenue is an estimate, not a measurement

Both package summary functions allocate package revenue across services by line share:

```
al_share = line_value / alloc_sum
al_cut   = p_cut * al_share |round:2
```

Each share is rounded to 2dp **independently**, so the per-service parts are not guaranteed to
sum to the package total — classic penny drift, and it grows with line count. More importantly
the allocation is a *modelling choice* (revenue attributed at purchase, proportional to line
value) presented in the same table as measured per-service booking revenue. They aren't the
same kind of number.

Not urgent — the amounts are small and the approach is defensible. But the v2 per-service
report should either label allocated revenue distinctly or attribute it at redemption.

### A4. Stripe customer lookup races

`find_or_create_stripe_customer` searches `api.stripe.com/v1/customers/search` by phone +
`metadata[provider_id]`, and creates one if the search returns nothing.

Stripe's search index is **eventually consistent** — it lags writes by up to a minute. Two
bookings for the same client inside that window both search, both miss, and both create. You
get duplicate Customers, which will matter when card-on-file lands (FET-26).

Cheap fix in v1: store `stripe_customer_id` on your own row and check that first, falling back
to search only on a miss.

---

## B. Architecture — don't fix in v1, fix by migrating

These are the costs that justify v2. Listed so the v2 work has explicit targets.

### B1. Loop-based aggregation

`/admin/revenue` (429 lines) loads **every transaction ever** with no date filter, then:

- an N+1 `db.get bookings` → `db.get provider_services` per transaction to resolve `service_id`
- nested `foreach` over providers × transactions
- nested `foreach` over services × transactions
- a linear scan over `months` per transaction just to build a distinct list

Its own comment concedes "Loop-based aggregation (tiny volume)." At current volume it's fine;
it is O(n×m) and will not stay fine. In v2 this is one `GROUP BY` over `ledger_entries`.

Full-table scans (no `where`) appear in 5 admin endpoints: `admin/revenue` (×2),
`admin/dashboard-summary` (×2), `admin/bookings`, `admin/room-rentals`,
`admin/training-courses`. This is also why BUG-09 exists — admin surfaces 429 on Xano Free.

### B2. The 904-line webhook

`/webhooks/stripe/platform` handles `payment_intent.succeeded`,
`checkout.session.completed`, `invoice.payment_succeeded`, `invoice.payment_failed`,
`customer.subscription.deleted` and `charge.refunded` in one function — bookings, memberships
and training all interleaved. A1 is exactly the kind of bug this shape produces: the refund
branch was written for training and nobody noticed bookings weren't covered.

Four webhook endpoints (`/connect`, `/platform`, `/room`, `/package`) each re-implement the
same signature-verification and logging preamble.

### B3. Two role systems

11 endpoints gate on `providers.is_admin`. Two also reference `role`. The `role` enum
(`platform_owner`, `developer`, `medical_director`, `real_provider`, `test_provider`) and
`is_admin` are independent, and nothing enforces that they agree. v2 collapses to `role` only.

### B4. Auth checks are inconsistent by construction

`get_authenticated_provider` validates existence and `status != "inactive"` — but not
`booking_enabled` and not `medical_director_status`. Those two gates are enforced
per-endpoint, and partly in page JS. There is no single place that answers "may this provider
book?"

Separately, endpoints declaring `auth = "providers"` without calling
`get_authenticated_provider` (e.g. `/room/availability`) skip the deactivated-account check
entirely — a deactivated provider can still read the rental calendar.

### B5. Dead scaffolding

The `user` and `event_log` tables, plus `Quick Start/log_event`,
`Quick Start/enforce_role` and `Quick Start/generate_magic_link`, are Xano quick-start
templates (tagged `xano:quick-start`). They reference `user`, not `providers`, and nothing in
the app calls them. `generate_magic_link` implements a **second, dead password-reset system**
alongside the real `password_reset_tokens` table. Not ported to v2.

---

## C. What v1 got right — preserve this

Worth stating plainly, because the migration should not regress any of it.

- **Webhook signatures are properly enforced.** All four endpoints compute HMAC-SHA256 over
  `t.raw_body` and halt on mismatch via `precondition`, *after* logging the attempt with
  `verify_passed`. That's the correct order — you keep forensics on rejected calls.
- **Money writes are idempotent at the payment-intent level.** Every ledger insert is guarded
  by a `count` query on `stripe_payment_intent_id` (+ `type`). This is better targeted than
  event-id dedupe, because it survives Stripe replaying a different event for the same charge.
  *(Note: `webhook_log.event_id` is written but never read back — the PI guard is what's
  actually protecting you.)*
- **Splits are computed at write time and persisted**, not derived at read time. A rate change
  in `platform_settings` cannot retroactively rewrite history. This is the correct choice and
  v2 keeps it.
- **`client_package_items` snapshots from the template at purchase**, so editing a template
  never rewrites a sold package.
- **Soft-delete on `package_templates`**, with reactivate — purchase history stays intact.
- **Voided redemptions are kept for audit** (`voided_at`) rather than deleted, and excluded
  from balance math.
- **The unearned-revenue insight.** `get_provider_package_summary` documents that the 50/50
  split settles at *purchase*, so package payout is money received for sessions not yet
  delivered — "unearned revenue, not earnings for work done" — and computes `unearned_value`.
  This is the most financially sophisticated thing in the codebase. v1 identifies it but only
  reports it; **v2 should model it as a real liability drawn down by redemptions.**

---

## D. Implications for the v2 import

What this review changes about the ETL, beyond the Phase 5 appendix:

1. **Normalize tips at import.** Non-negotiable — see A2. Decide one convention
   (recommendation: `gross_amount` excludes tip, `tip_amount` separate) and transform both
   source ledgers into it.
2. **Refunds must be sourced from Stripe, not from v1's ledger.** *(Load-bearing — A1 is
   deliberately not being fixed in v1; see `fixes/FIX-booking-refunds-to-ledger.md`.)*

   Because of A1, v1's `transactions` table contains **no booking refunds at all**, and per
   BUG-21 `charge.refunded` is not subscribed in Stripe live, so it never will. v1's lifetime
   revenue is overstated by the sum of every refund ever issued.

   The ETL must therefore pull refunds from the **Stripe API** and generate the corresponding
   `ledger_entries` rows with `entry_type = 'refund'`. If it transforms only what's in
   `transactions`, v2 inherits the overstatement permanently and silently.

   Consequences to plan for:
   - Reconciling v2 against v1 **will** show a discrepancy. That is v2 being correct. Quantify
     the refund total from Stripe first so the gap is explainable rather than alarming.
   - The same applies to training: the `charge.refunded` branch that adjusts
     `training_enrollments.amount_paid` has also never run in live, so refunded enrollments
     may show inflated `amount_paid` / stale `payment_status`.
   - Resolve the `reverse_transfer` question before writing the transform — it decides whether
     a refund reduces `provider_payout` or only `melanite_cut`.
3. **Three ledgers → `ledger_entries`.** `transactions` → `source='booking'`,
   `package_transactions` → `source='package'`, `room_transactions` → `source='room_rental'`
   with `payer='provider'`. Memberships must be reconstructed from Stripe invoices; training
   from the inline columns on `training_enrollments`.
4. **`room_transactions` has no split columns** — set `melanite_cut = amount`,
   `provider_payout = 0`, `payer = 'provider'`. The v2 check constraint enforces this.
5. **uuid PKs throughout** — IDs port as-is, no sequence resets, FK values stay valid.
6. **Passwords are not portable** (Xano's HMAC keying is undocumented). Import with
   `password_hash` null and `requires_password_reset = true`.
7. **Clients must be deduped on lowercased email** to build the `clients` table; v1 stores the
   identity as a string on `client_packages` and as loose text on `bookings`.
8. **Verify timestamp units on first export** — Xano commonly exports epoch milliseconds.
   Check one CSV before loading everything.
