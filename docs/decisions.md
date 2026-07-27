# Decisions and backlog

Running record of choices made during the v2 build, and work deliberately deferred. The
migration plan lives at `~/.claude/plans/the-database-of-the-robust-perlis.md`; this is the
delta since.

## Decided

### Domains — 2026-07-27

- **`app.melanitesuite.com`** — the whole v2 app: `/app/*` provider portal AND `/pay/*` client
  checkout.
- **`melanitesuite.com`** — marketing only, stays on Webflow for SEO.

`/pay` moves to the app domain rather than staying on the apex. Webflow cannot reverse-proxy to
a Next app, so `melanitesuite.com/pay/…` could only keep working by staying on Webflow+Wized —
and that version cannot read v2's database. One deployment, one domain for anything that
touches data.

Risk checked and found small: only 4 payment links were outstanding at the time of the
decision, all expiring by 2026-07-31, so no client is stranded mid-flow by the move.

Session cookies are host-only (no `domain` attribute), so they scope to
`app.melanitesuite.com` and never reach the apex. That is already correct and needs no change.

### Discounts — 2026-07-27

Providers can discount by percentage **or** flat dollar amount. Stored as `discountType` +
`discountValue` rather than a single percentage, because how the discount was *expressed* is
information: "10% off" and "$25 off" can produce the same price today and diverge the next time
the service is repriced.

### Admin tools — 2026-07-27

Three narrow tools at `/app/admin/tools`, not a generic table editor:

1. **Record a payment** against an existing booking — Cherry, Groupon, cash, check, other.
2. **Record a medical-director payment** made directly to Keoni, covering N months.
3. **Add an appointment** on a provider's behalf.

A free-form row editor would cover all three in a tenth of the code. It was rejected because
the ledger's correctness lives in invariants a form can enforce and a text box cannot: the
provider-paid rows must be unsplit, a Stripe row must carry its reference, and a booking must
not receive two payments. v1's revenue was $2,000 out precisely because money could be entered
in shapes nothing checked.

Deliberate choices worth keeping:

- **Splits default to `platform_settings.provider_share_pct`, with an override.** A Groupon
  voucher the provider sold and collected on directly is theirs entirely; forcing the platform
  split would book revenue Melanite never received.
- **Manual payments leave `payout_status = 'pending'`.** Stripe Connect cannot settle money it
  never received, so the provider's share still has to be paid by hand — and should show up as
  owed until it is.
- **The manual booking skips the provider gates but keeps the collision check.** An appointment
  that already happened should not be refused because the provider's licence lapsed afterwards;
  the laser, however, cannot be double-booked by anyone.
- **Date and time are separate fields, not `datetime-local`.** That input reports the browser's
  local time, which would silently shift every appointment entered from outside Mountain Time.
- **`recorded_by` makes it all attributable**, and the page lists those entries back. A
  hand-entered figure should always be traceable to a person.

## Backlog

### Multi-service bookings

A booking currently references exactly one `provider_service_id`. Providers need to schedule
several services in one appointment, but **not every combination is clinically sensible** — the
allowed pairings are a question for Keoni, and inventing them would be inventing medical policy.

Blocked on: that list.

Scope when unblocked — this is a model change, not a UI change:

- `bookings.provider_service_id` becomes a line-item collection.
- Duration becomes the sum of its services, which changes availability and the global collision
  check.
- Earnings attribution per service has to split across the line items.
- Package redemption has to decide whether one booking can consume sessions from several lines.

### Stripe writes still unbuilt

- Room rental payment intent (needs the room rental screen, which does not exist yet).
- Package checkout link generation (needs `/pay/package/*`).

### v1 questions still open, carried forward

- **Q-04** — package expiry default, blocked on Idaho gift-certificate law pending an attorney.
  The field exists and is deliberately left blank; a pre-filled number becomes policy.
- **Q-06** — whether a checkout discount applies to packages per-session or whole-package.
  Nothing in v2 implies an answer yet.
- **`reverse_transfer`** — refunds currently assume the provider keeps their share, which is
  what live data showed (`transfer_reversal: null`). If refunds start being issued WITH
  transfer reversal, `handleChargeRefunded` needs the proportional split instead.
