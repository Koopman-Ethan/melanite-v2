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

### Admin calendar — 2026-07-27

A **resource** calendar, not a per-person one. There is one laser, so the question the page
answers is "what is the machine doing and who has it" — which no provider-scoped view can show.
Week grid, all providers on one timeline, at `/app/admin/calendar`.

- **All positioning is computed server-side in Denver wall-clock** and shipped as minutes-from-
  midnight. The client does layout only and never touches a timestamp. Same reasoning as the
  admin tools' date/time split: an admin in another timezone must see the laser's calendar, not
  their own.
- **Overlapping bookings are laid out side by side and counted in a warning.** On a single-laser
  business `lanes > 1` cannot legitimately happen; drawing them stacked would hide one behind
  the other, and drawing them side by side silently would read as normal.
- **Cancelled and no-shows are fetched but hidden behind a toggle.** They do not occupy the
  laser, but "did that get cancelled?" is a question this page should answer. They are excluded
  from lane assignment so a cancellation cannot push a real appointment sideways.
- v1's `GET /admin/bookings` returned **every booking ever** with no date filter, then ran two
  further queries per row to resolve the provider and service names. Replaced with one joined
  query over a week window.

### Booking calendar — 2026-07-27

The Book page opened with a native date field and a slot grid. That was a Phase-1 shortcut, not
a design decision, and it was wrong for this business specifically.

**Why a calendar earns its place here:** the laser is shared. "Is the 14th any good?" is not a
question a provider can answer from their own schedule — the day may be full because of someone
else entirely. A date field makes them pick a day, wait for a render, read an empty grid, and
try again. The calendar answers it for the whole month at once.

- **Counts are duration-specific.** A 30-minute service and a two-hour one get genuinely
  different calendars, which is why `getMonthAvailability` takes a duration rather than
  reporting a generic "busy" score. A day with three scattered 30-minute gaps is wide open for
  one service and useless for the other.
- **One slot loop, shared.** `buildSlots` backs both the day grid and the month counts. Two
  implementations of "how many slots are free" is exactly how a calendar ends up promising a day
  that turns out to be full.
- **Three bands, not a gradient** — wide open / some room / nearly full. The provider is
  choosing between days, and that is the distinction that changes the choice.
- Month is its own URL parameter so the calendar can be browsed ahead of the selected day.
  Picking a day sets both, so the two cannot drift apart.

Note that today's dot reflects *bookable* slots, so a quiet afternoon still reads "nearly full"
by evening. That is intended: what the provider needs to know is how many openings remain, and
the heading below the calendar gives the exact count.

### Room rental — 2026-07-27

`/app/room-rental`. Full day or half day, provider pays Melanite, so `payer = 'provider'` and
the whole amount is `melaniteCut` — no split, no Connect transfer.

**Occupancy is an EXCLUDE constraint on the time range**, not a unique index on
(date, slot_type). The unique index v2 shipped with looked right and was not: it stopped two
`am` bookings on a day but happily allowed `full` to be sold on a day that already had one.
Verified by inserting `am` then `full` on the same date — the constraint now refuses it, and
`pm` still succeeds.

**Reserve, then pay.** v1 checked availability with a read, created no row, and called the
webhook "the atomic commit". Nothing held the slot in between, so two providers could both pay
for the same day and one had to be refunded by hand. Here the row is written as `pending` first
and the constraint decides; a race surfaces as `23P01` and is reported as "that block was just
taken". Holds expire after 30 minutes, swept on read — there is no scheduler in this stack yet,
and a stale hold that clears when someone next looks is still cleared before it affects them.

**Prices and hours moved to `platform_settings`.** v1 hardcoded 100 and 60 inside
`POST /room/rental-intent`, so changing what the room costs meant editing an endpoint.

**Gates are deliberately not the booking gates.** Renting the room is a space rental, so
`bookingEnabled` + `roomRentalEnabled` (per provider) + `roomRentalEnabled` (platform) apply,
but the medical-director and licence gates do not. v1 drew the same line. Cancellation is not
gated at all — turning the feature off must never strand a provider with a booking they cannot
cancel.

Two bugs fixed in `roomRentalPaid` while wiring this up:

- It fell back to `subjectId: pi.id` when no rental matched. `subject_id` is a `uuid` column and
  `pi_3Abc…` is not a uuid, so the defensive fallback was the one path guaranteed to throw.
- It matched on (provider, rental_date) with no slot, so a provider holding both `am` and `pm`
  on one day could have either payment confirm the wrong block.

Both are fixed by carrying `room_booking_id` in the PaymentIntent metadata.

### Migrations: enum values need their own run — 2026-07-27

`drizzle-kit migrate` reported success and changed nothing when applying 0008. The environment
is not at fault, and an earlier version of this note blamed the driver — that was wrong.

What is actually true, each point tested:

- The WebSocket path drizzle-kit uses **works**, including transactions. `@neondatabase/serverless`
  picks up Node 24's global `WebSocket` with no configuration.
- `drizzle-kit migrate` **works** — a no-op migration applied and reported `✓`.
- The failure is a Postgres rule: `ALTER TYPE … ADD VALUE` followed by any *use* of that value
  in the same transaction raises `55P04 unsafe use of new value`. Migration 0008 adds `'pending'`
  to `room_booking_status` and then sets it as a column default.
- **Splitting it across two migration files does not help.** drizzle-kit wraps the whole run —
  every pending file — in one transaction, so the two statements still meet. Tested directly.
- drizzle-kit's real failing is that it swallowed the error and exited 0. A migration tool
  reporting success while applying nothing is worse than one that fails loudly.

So `npm run db:migrate` runs `scripts/migrate.ts`, which sends statements one at a time and logs
each. `drizzle-kit generate` is still how migrations are authored, and `db:migrate:kit` keeps
the original command available.

Trade-off: without a transaction, a failure halfway leaves the schema partly changed. Each
statement is logged as it runs, and a migration is recorded only after all of its statements
succeed. For a migration with no enum changes, `db:migrate:kit` is the safer of the two.

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

- Package checkout link generation (needs `/pay/package/*`).

### v1 questions still open, carried forward

- **Q-04** — package expiry default, blocked on Idaho gift-certificate law pending an attorney.
  The field exists and is deliberately left blank; a pre-filled number becomes policy.
- **Q-06** — whether a checkout discount applies to packages per-session or whole-package.
  Nothing in v2 implies an answer yet.
- **`reverse_transfer`** — refunds currently assume the provider keeps their share, which is
  what live data showed (`transfer_reversal: null`). If refunds start being issued WITH
  transfer reversal, `handleChargeRefunded` needs the proportional split instead.
