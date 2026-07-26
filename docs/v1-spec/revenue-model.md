# v1 revenue model — how the money picture fragmented

Source: Xano workspace 161739 (`Keoni's Workspace`), branch `v1`, read 2026-07-26 via the
Metadata API. Table definitions are checked in under `docs/v1-spec/schema/*.xs`.

## The finding

The migration plan recorded this as "the ledger already exists and was designed correctly, but
its `source` enum was never extended past `booking`." The schema confirms the enum, but the
actual situation is more specific and more instructive.

**Money arrives through five primitives. They land in five different shapes.**

| Primitive | Where the money is recorded | Payout split? |
|---|---|---|
| Laser bookings | `transactions` (`source` enum = `["booking"]`) | `provider_payout` / `melanite_cut` |
| Packages | `package_transactions` — a **second ledger** | `provider_payout` / `melanite_cut` |
| Room rentals | `room_transactions` — a **third ledger** | none: single `amount` |
| Medical-director membership | **no ledger row at all** — Stripe subscription only | n/a |
| Training enrollments | **no ledger row at all** — money denormalized onto `training_enrollments` | n/a |

Three ledgers with three different column vocabularies, plus two revenue streams with no
ledger entry anywhere.

## The fork was deliberate, and it cited itself as precedent

This is the part worth carrying forward. The tables document their own reasoning:

> `room_transactions` — "rental payment ledger, **kept separate from the laser transactions
> table so laser revenue reporting stays clean and un-split**."

> `package_transactions` — "package money ledger, **SEPARATE from the live transactions table
> (D1, the room_transactions precedent: the laser ledger stays clean and untouched).**"

Each new revenue stream was kept out of the ledger to protect the existing reports, and the
second one justified itself by pointing at the first. The same reasoning appears again in the
endpoints — `/admin/revenue` and `/admin/dashboard-summary` both carry a 2026-07-25 note:

> "**ADDITIVE ONLY.** Every pre-existing key stays BOOKING-ONLY and keeps its exact prior
> value — that is what the /app/admin tiles mean today."

So the pattern is stable and self-reinforcing: never redefine an existing number, always add a
parallel one. Each individual decision is locally reasonable — none of them wanted to silently
change a figure Keoni was already reading. Compounded five times, it is the reason the revenue
picture doesn't exist.

**This is the thing v2 has to fix at the model layer, because it cannot be fixed at the
reporting layer.** No amount of dashboard work reconciles three vocabularies and two absences.

## What `/admin/revenue` actually returns today

The flagship endpoint — the one meant to answer "what did the business make?" — returns
*fourteen* keys, including three different definitions of revenue:

- `lifetime_revenue` / `month_revenue` — **bookings only**
- `package_lifetime_revenue` / `package_month_revenue` — **packages only**
- `combined_lifetime_revenue` / `combined_month_revenue` — bookings + packages

`combined_*` is presented as the true platform total. **It is not.** Room rentals, memberships,
and training revenue are absent from this endpoint entirely — they live behind separate admin
list endpoints (`/admin/room-rentals`, `/admin/training-enrollments`) and Stripe. The endpoint
that exists to give Keoni the revenue picture covers **two of five** streams while labelling
the result "combined".

Mechanically it is also a warning about the platform, not just the model: it loads every
transaction into memory with no date filter, does an N+1 `db.get` per transaction to resolve
`booking → provider_service → service_id`, then runs nested per-provider × per-transaction and
per-service × per-transaction loops in XanoScript. Its own comment concedes "Loop-based
aggregation (tiny volume)." In v2 this endpoint is one `GROUP BY`.

## What this changes about the v2 model

The plan's prescription — one ledger, extend the `source` discriminator — is right, but the
schema surfaces two constraints it didn't account for:

**1. Money flows in two directions, and a naive `SUM` would be wrong.**

- *Client-paid, provider-earning* — bookings, packages. A client pays; the money splits
  `provider_payout` / `melanite_cut`. Platform revenue is the **cut**.
- *Provider-paid, platform-earning* — room rentals, medical-director memberships. The provider
  pays Melanite. There is no split; the platform keeps **all** of it. This is exactly why
  `room_transactions` has a bare `amount` and no payout columns — it wasn't an oversight.
- *Student-paid* — training. `training_enrollments.provider_id` is nullable and there's an
  `invite_link_id`, so the enrollee typically isn't a provider yet. Effectively 100% platform.

A single `source` enum over a single `gross_amount` column does **not** capture this. Summing
`gross_amount` across all five would count a provider's $150 membership payment the same way as
a client's $400 laser session, of which Melanite keeps half. The ledger needs an explicit
counterparty/direction concept alongside `source`, so that "platform revenue" is one
unambiguous expression rather than a per-source special case.

**2. The subject reference has to be polymorphic.** `transactions.booking_id` is a hard FK
today. A unified ledger needs to point at a booking, a package purchase, a room rental, a
membership period, or a training enrollment.

**3. Bookings still need an explicit payment source.** Unchanged from the plan and confirmed:
`bookings` has `price`, `original_price`, `discount_pct` — and nothing recording *how* it was
paid. Package redemptions land here as ordinary $0 bookings, which is why the UI infers payment
method in three separate places.

## Secondary observations

- **`providers` is doing three jobs.** 42 columns spanning identity/auth, Stripe Connect
  onboarding, medical-director credentials (8 `md_*` columns for the "own director" path), and
  5 `notify_*` preference booleans. Candidates to split in v2.
- **Two overlapping role systems.** A `role` enum (`platform_owner`, `developer`,
  `medical_director`, `real_provider`, `test_provider`) *and* a separate `is_admin` boolean —
  and `/admin/revenue` gates on `is_admin`, not `role`. Pick one in v2.
- **`test_provider` as a role value is Free-plan tax.** Xano Free has no test data source, so
  test accounts live in production distinguished by an enum. v2 should not inherit this; see
  the Free-plan workarounds note.
- **Two booking gates.** `medical_director_status` (subscription) and `booking_enabled`
  (manual admin flip) are independent and both must pass. Worth keeping — but as modelled
  state, not page JS.
- **`platform_settings` is a singleton config row** (`provider_share_pct`, hours, feature
  flags). The splits are computed from it at write time and persisted on the transaction,
  which is correct and should carry over — rate changes must not retroactively rewrite history.
