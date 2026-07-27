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

### Client checkout `/pay/*` — 2026-07-27

Inline Stripe Elements on a Melanite-branded page, not a hosted redirect. Every other Stripe
flow in v2 (membership, room rental) redirects, and those stay as they are — they are
provider-facing. This is the only page a paying client sees, and four things pushed it the
other way:

1. **The card mandate is the point.** Storing a card to charge someone who is not present makes
   the consent wording a legal artifact: it has to name the fees, sit next to the pay button,
   and be recorded with a version stamp. Stripe's hosted page offers a constrained
   `terms_of_service_acceptance` slot and little control.
2. **A client following a texted link should land somewhere recognisably Melanite.**
3. **Tips only work inline.** A hosted session fixes the amount at creation, so the client
   cannot reconsider the tip on the payment screen without backing out.
4. **Cherry belongs beside "pay by card"**, not behind a redirect.

PCI position is unchanged: Elements iframes the card fields from Stripe, so no card number
touches this origin. Both approaches are SAQ-A.

**Card on file.** `setup_future_usage: 'off_session'` saves the card to a Customer on the
PLATFORM account — not the provider's connected account, which would be unusable for the one
thing it was collected for. `clients.cardOnFileConsentAt` + `cardOnFileConsentVersion` record
what was agreed and when; `chargeBookingFee` refuses to charge a card that has no consent row,
whatever Stripe would technically allow.

**Fees are split evenly** via `feeProviderSharePct`, deliberately separate from
`providerSharePct`. A missed appointment costs the provider their chair time and Melanite the
laser slot; neither absorbs it alone, and a fee is not a service, so the two rates should be
able to diverge. `no_show_fee` and `late_cancellation_fee` are their own ledger entry types —
Keoni needs penalty income separately from service income, and a free-text note is not
something you can group by. v1 charged neither: no-show fees were "deferred to Phase 3" and it
saved no card to charge.

**Charging is opt-in per action.** `markNoShow` and `cancelBooking` take an explicit flag and
default to not charging. Every ambiguous case declines and says why — no card, no consent, no
price to work from, a fee already charged on that booking.

**The split verified against Stripe**, not just asserted: a $200 service with a 20% tip
produced `amount: 24000` and `application_fee_amount: 10000`. The fee is 50% of the service
only, so the whole $40 tip reaches the provider — v1's rule, and the one providers were told.

Testing this needed a sandbox Connect account, because the imported provider rows hold LIVE
`acct_` ids and a test key cannot pay them ("No such destination"). Express and Standard test
accounts cannot have their ToS accepted by the platform, so the working shape was a
`controller[requirement_collection]=application` account, which activates `transfers`
immediately.

**Verified end to end in the sandbox**, including the card step: a $200 payment through Stripe
Link produced the ledger row ($100/$100), flipped the link to paid, and saved the payment method
with a consent stamp. Cancelling that appointment inside the 24-hour window then charged $50
off-session, split $25/$25, with the Stripe intent confirming
`application_fee_amount: 2500` against the provider's account. All test rows removed afterwards.

One thing the test surfaced: paying via **Stripe Link** produces a payment method of type
`link` with **no card object at all**, so brand and last four came back null and the ledger note
would have read "•••• ????". `clients.paymentMethodType` now records the type and the note
describes it accordingly. Worth remembering — anything that assumes a saved method is a card is
wrong for Link, Apple Pay and bank debits alike.

Cherry is live at `https://pay.withcherry.com/melanite-laser-suite`.

### Email — 2026-07-27

Resend, via its REST API in `lib/email.ts` — no SDK dependency. Already used for password
resets; now also sends the package link when one is created, and tells a client when their card
on file has been charged.

That last one is not optional politeness. Taking money from someone who is not present and
saying nothing is indefensible: they agreed to the fee, not to finding out from their bank
statement. A send failure is logged and swallowed, because it must never undo a charge that
already went through.

With no `RESEND_API_KEY` set, `sendEmail` logs loudly to the console and reports
`delivered: false` rather than pretending. Callers surface that honestly — the package link
action says "copy it to your client" rather than "emailed" when nothing was sent.

### Training — 2026-07-27

Admin at `/app/admin/training`, public enrolment at `/training`, balance payment at
`/pay/training/[enrollmentId]`.

**The money is not on the enrolment row.** v1 kept `deposit_amount`, `amount_paid`,
`balance_due` and two Stripe intent ids there, wrote no ledger entry, and therefore never showed
a dollar of training revenue in any admin total. Here the ledger is the record and every figure
— paid, owed, collected, outstanding — is derived from it, so "paid in full" cannot drift from
"there is money against this". `refreshPaymentStatus` recomputes rather than increments, which
is what makes a replayed webhook or a refund harmless.

**Training takes no provider split.** `payer = 'student'`, no `transfer_data`, no
`application_fee_amount` — the charge stays wholly on the platform account. Verified against the
created intent: `transfer_data: null`.

**Re-enrolling with the same email reuses the row.** v1 refused with ALREADY_ENROLLED, which
strands anyone whose first card attempt failed — they cannot retry and cannot enrol.

**Seats count enrolments that have paid something.** An abandoned form must not hold a place.

**Completing a course does not invite anyone.** v1's note, kept: Keoni issues provider invites
separately, and finishing a course is not the same as being cleared to practise. Cancelling a
course does not auto-refund either — a deposit may be transferable to another date, which is a
conversation rather than a rule.

The balance link is addressed by enrolment id and carries no token. That is v1's design and it
holds up: the page reveals only that student's own name, course date and balance, and the link
has to survive being re-sent months later. A rotating token would break every email already out.

### Payment methods are stated, not delegated — 2026-07-27

Every PaymentIntent lists `payment_method_types: ['card', 'link']` instead of
`automatic_payment_methods: { enabled: true }`.

Automatic methods hand the choice to Stripe, which surfaces whatever it thinks converts — Klarna,
Afterpay, Cash App — and cannot be reliably suppressed from the Dashboard: those toggles are
per-mode, and turning one off in test leaves live untouched, which reads as the setting not
working.

Beyond determinism there is a business reason: Melanite's financing partner is Cherry. A
competing BNPL button beside it splits the one route the business has a relationship with.
`card` covers Apple Pay and Google Pay, which ride the card rail rather than being separate
types.

### The admin queue — 2026-07-27

`/app/admin/queue`. One list of everything waiting on a human decision about money.

Three situations exist where the system deliberately stops short of deciding, because deciding
would be wrong:

1. **A room rental cancelled inside 24 hours.** The block is freed either way; whether the
   provider gets their money back is Keoni's call.
2. **A no-show or late-cancellation fee that failed to charge** — declined card, no card on
   file, no consent recorded. The appointment status is recorded; the money is not.
3. **A cancelled course with deposits already taken.** Refundable or transferable to another
   date, which is a conversation rather than a rule.

Only the first existed in v1, surfaced through a room-rentals endpoint filtered on
`cancellation_requested`. The other two could not exist there: v1 never charged a fee and never
cancelled a course in software. In v2 all three could already happen and **none of them were
visible anywhere** — a provider cancels late and the refund decision has nowhere to live.

**Derived, not stored.** Every item comes from the state of the thing itself — a rental's
status, a booking's `feeChargeFailedAt`, a course's status plus its ledger. A separate
work-queue table is one more store that can disagree with reality, and an item lingering after
it has been resolved is worse than no queue. The corollary is enforced: every action ends with
the item leaving the queue, either because money moved or because someone recorded a decision
that it should not.

**Failed fees are stamped on the booking**, not queued elsewhere: `feeChargeFailedAt`,
`feeChargeError`, and `feeWaivedAt` + `feeWaivedBy`. Waiving keeps the record — it distinguishes
"handled, no" from "nobody looked", which is the entire point. A later successful charge clears
the failure, so a retry that works removes the row rather than leaving a solved problem in view.

**Sorted oldest first.** Age is what matters in a queue: the thing waiting longest is the thing
most likely to have been forgotten.

Transferring a student between courses moves the enrolment row rather than refunding and
re-charging. The ledger entries key on the enrolment id, so the money follows it and their
balance stays correct against the new course's price.

### The booking payment link had nowhere to go — 2026-07-27

A booking created its checkout link and then showed it to nobody. The action redirected to
`/app/appointments?booked=<id>` and the appointments page ignored the parameter entirely, so a
provider finished booking with no way to reach the link short of querying the database. The
whole `/pay/*` flow was unreachable in practice.

Two halves to the fix:

- **Emailed at creation** when the client gave an address, using the Resend wrapper. Best
  effort: a booking that succeeded must never be reported as failed because an email bounced.
- **Shown on the next screen either way**, with a copy button. Most of these travel by text
  message, so email is a convenience rather than the delivery mechanism, and the link is offered
  for copying even when the email went out.

The banner tells the truth about what happened: "emailed to X", or "email isn't set up yet, so
nothing was sent — copy the link and send it yourself". `sendEmail` reports `delivered: false`
rather than throwing when unconfigured, and the caller passes that through instead of claiming
a send.

`getBookingLink` is scoped to the provider. A link token is a bearer credential for someone
else's payment page, and reading one by guessing booking ids must not be possible.

### Design tokens, measured — 2026-07-27

`npm run a11y:contrast` reads the tokens straight out of `globals.css` and checks each against
the surfaces it actually appears on. Contrast is the one accessibility property that cannot be
eyeballed, and a dark theme looks fine to anyone with good eyes on a good monitor right up until
it doesn't.

What it found:

- **`ink-faint` was #666666 — 2.87:1 on `overlay`**, against a 4.5:1 requirement. It is used for
  hints, legends and captions at 10–12px, so the smallest text in the app was also the least
  readable. Now #8a8a8a, clearing AA on canvas, surface and overlay. `ink-muted` moved to
  #a8a8a8 to keep the ramp's steps distinct.
- **Control borders had no token.** `--color-line-control` (#6a6a6a, 3.4:1) now bounds inputs
  and outline buttons — WCAG 1.4.11 asks 3:1 for anything needed to identify a component, and an
  empty input edged in #2a2a2a is genuinely hard to find. Decorative card borders keep `line`;
  holding those to 3:1 would mean drawing every card in near-grey for no benefit.
- **`--color-ink-disabled`** replaces scattered `text-ink-faint/40`. Disabled controls are exempt
  from contrast rules, so this is allowed to be dim — but naming it makes "disabled" a decision
  rather than an opacity guess.

Two corrections to my own earlier audit, both from checking rather than assuming:

- **Focus rings already existed** — a global `:focus-visible` gold outline in `globals.css`, with
  nothing overriding it on interactive elements. I claimed they were missing.
- **`critical` "failing" was a bad check.** It is a background with white text on it, so the pair
  that matters is ink ON critical (4.84:1, passes). Measuring it as a foreground measured the
  wrong direction. Same for `danger`, which is only ever a tint or a dot — that check was removed
  rather than "fixed", because a threshold on a combination that does not exist trains you to
  ignore the output.

### Colour is never the only signal — 2026-07-27

The booking and room-rental calendars encoded availability as a green/amber/red dot. The legend
mapped colour to meaning, so a red-green colourblind provider — roughly 1 in 12 men — could not
read the busiest control in the app at all. Straight WCAG 1.4.1 failure.

- **Booking calendar:** a three-bar meter. The *count* of filled bars carries the level; colour
  only reinforces it. Works in greyscale.
- **Room rental:** two marks, one per bookable half-day. Better than the dot it replaced, not
  merely more accessible — you can now see *which* half is gone rather than just "part taken".
  "Yours" is an added glyph rather than a fourth hue.

Touch targets on inputs and both button sizes are now 44px minimum. `sm` buttons were 27px —
fine with a mouse, poor for a provider tapping between clients one-handed.

### Accessibility, in three layers — 2026-07-27

Each layer catches what the one below it cannot, and none of them is sufficient alone.

**1. Lint (`npm run a11y:lint`)** — `eslint-plugin-jsx-a11y` strict, set to error rather than
warn, because a warning in a project this size is a thing nobody reads. Found 5 issues across
~30 files: `autoFocus` on the three auth forms (removed — on a phone it opens the keyboard over
the page on load, and it moves a screen reader user without warning), and two consent checkboxes
the default rule depth could not see text inside. The label markup was correct; the rule only
looks two elements deep, so that was a config fix rather than a suppression.

**2. Contrast (`npm run a11y:contrast`)** — reads tokens from `globals.css`; see the token entry
above.

**3. axe in a real browser (`npm run a11y`)** — Playwright, every page, at 390×844 and desktop.
This is the layer that found things the other two structurally cannot:

- **Text on a colour-mixed background.** Admin calendar blocks tint by the service's own colour,
  so contrast varies with whatever hue that service was given — 4.06:1 on the gold tint. No
  flat-token check can see this; only the rendered pixel can.
- **Row-level opacity.** `opacity-70` on refunded rows dimmed every colour inside them, dropping
  the refund badge to 2.71:1. The badge already says "refund", so the opacity was decoration
  doing damage.
- **A hue cannot contrast with itself.** `text-danger` on `bg-danger/15` measured 4.25:1.
  `--color-danger` lifted to #d97b7b, which clears AA on both the plain surface and its own tint.
- **Scrollable regions were keyboard-unreachable.** Five `overflow-x-auto` tables could be seen
  but not scrolled without a mouse. Now `role="region"` + `tabIndex={0}`.
- **My own misuse of `ink-disabled`** on legend swatches — 2.75:1. A legend describing a
  disabled state is informational text, not a disabled control; the WCAG exemption does not
  reach it.

axe and jsx-a11y contradict each other on the scrollable region: axe requires the tabIndex,
the lint rule forbids it on a div. axe is right, and the rule is configured to permit it for
`role="region"` only.

**What this does not prove.** axe catches perhaps a third of accessibility problems — the
mechanical ones. It cannot tell you whether a flow makes sense to someone who cannot see it. A
manual screen reader pass is still outstanding, and treating a clean axe run as "accessible" is
the standard mistake.

### Tests, and the bug they found immediately — 2026-07-27

Vitest for units and database invariants (`npm test`); Playwright already covers accessibility
and will carry end-to-end journeys.

The priority was never coverage percentage. It was: **test where being wrong is expensive AND
silent.** v1's revenue was $2,000 out for months because nothing crashed — the numbers were just
wrong. So the suite starts with timezone conversion, the booking gates, and properties asserted
over every row in the ledger.

**Invariants run against the development database, not fixtures.** A fixture only contains the
shapes you thought to create, and the rows that break an invariant are by definition the ones
nobody thought of. That decision paid for itself on the first run.

**What it found, within minutes of existing:**

All four membership ledger entries pointed at a **provider id** where a **membership id**
belonged. `subject_type = 'membership'`, `subject_id` = a provider — a polymorphic reference
that looks populated and joins to nothing. It had survived every ETL run, the reconciliation to
$2,052.75, and my own manual review, because no total is wrong when the pointer is: the money
adds up either way.

Two causes, both the same shape:

- `subjectId: membershipIdByProvider.get(providerId) ?? providerId` — a "defensive" fallback
  that turns a missing mapping into a confidently wrong answer. The identical pattern existed in
  `ledgerFromPackageTransactions` (`?? t.id`) and, earlier today, in `roomRentalPaid`
  (`?? pi.id`). Three instances of the same instinct.
- The loader passed `new Map()`, so the lookup could only ever miss.

Both fallbacks are gone — a missing mapping now throws and stops the import — and the loader
builds the map from the rows it just inserted. The four existing rows were repointed; the
platform total is unchanged at $2,052.75, which is precisely why nobody had noticed.

**One deliberate exception, bounded.** Two entries reconstructed from Stripe legitimately point
at nothing: the ETL found payments v1 had recorded no transaction for, so it built the ledger row
from the charge with no booking to attach it to. Inventing a link would be worse than admitting
there isn't one. The exclusion is narrow, their count and net value are pinned by a second test,
and a third test guards the predicate itself — a first attempt at the exclusion accidentally
skipped every entry with a NULL note, which is most of them, and still passed.

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

### v1 questions still open, carried forward

- **Q-04** — package expiry default, blocked on Idaho gift-certificate law pending an attorney.
  The field exists and is deliberately left blank; a pre-filled number becomes policy.
- **Q-06** — whether a checkout discount applies to packages per-session or whole-package.
  Nothing in v2 implies an answer yet.
- **`reverse_transfer`** — refunds currently assume the provider keeps their share, which is
  what live data showed (`transfer_reversal: null`). If refunds start being issued WITH
  transfer reversal, `handleChargeRefunded` needs the proportional split instead.
