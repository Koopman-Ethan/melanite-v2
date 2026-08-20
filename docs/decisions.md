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

### Constraint and journey tests — 2026-07-27

**Constraints are tested by attempting the corruption**, not by observing that today's rows are
clean. Those are different claims: data can be clean because nothing has tried to break it yet.
These write the bad row and require Postgres to refuse — the only way to know a constraint
survived a migration or a `drizzle-kit push`.

Assertions read the constraint NAME off `error.cause`, not a substring of the message. The
neon-http driver wraps failures in its own Error whose message is only "Failed query: …", so a
message match would have passed for *any* error — including a syntax error in the test itself.
A test that expects a rejection and gets the wrong rejection looks green.

Covered: the room exclusion constraint (a full day refused against a held morning, an afternoon
still allowed, a cancelled hold genuinely freeing the slot), provider-paid entries refusing a
split, Stripe entries requiring a reference while membership invoices are accepted without a
payment intent, one non-refund entry per payment intent but SEVERAL refunds allowed, booking
time order, package quantity, and the settings singleton.

**The journey test covers everything up to the card.** A provider books, lands on the
confirmation banner, the payment link is present and copyable, the client's view of that same
link renders with the consent language naming the actual fees, and cancelling removes it from
upcoming while leaving it visible under cancelled.

It deliberately stops before completing a payment. Entering card details is not something to
automate here, and the part after "client presses pay" is Stripe's — already verified once by
hand end to end. What the test covers is where this app's own logic lives.

Cleanup runs as a Playwright teardown, so it happens whether or not the tests passed. Cleanup
that only runs on a green build is cleanup that skips exactly the days it matters.

One assertion I got wrong and corrected: I expected "Appointment cancelled." to appear after
cancelling. It never does — the list is filtered to upcoming, so the element carrying the
message is the one being removed. The test now asserts the card leaves that list AND appears
under cancelled, which is both true and a stronger claim.

### Password and signature tests — 2026-07-27

Both are short, pure, and the kind of code that fails OPEN — a verifier that accidentally
returns true is indistinguishable from one that works until someone forges a request. Neither
had a single test.

**One real defect found in `verifyPassword`.** It derived a key of length `expected.length`,
taken from the stored value, and scrypt's final PBKDF2 step is prefix-stable — a 61-byte
derivation is genuinely the first 61 bytes of the 64-byte one. So a stored digest that had been
truncated still verified successfully.

Worth stating precisely, because my first framing overstated it: this was **not an
authentication bypass.** The correct password was still required, and a demonstration with a
one-byte digest accepted 0 of 256 wrong passwords. The defect is that a damaged hash failed
OPEN instead of closed, and that the work factor was negotiable by whatever happened to be in
the column. `verifyPassword` now requires the digest to be exactly `KEY_LENGTH` and always
derives at that length. All five existing hashes are 64 bytes, so nobody is locked out.

Signature verification held up under everything: wrong secret, altered body, missing and
malformed headers, expired and future timestamps, multiple `v1` values during a rotation
(any match is valid — checking only the first would break every rotation), signatures of the
wrong length (`timingSafeEqual` throws rather than returning false, so a truncated one must be
caught before it reaches there), and a re-serialised body, which must fail because verification
depends on the raw bytes.

Two of my own test expectations were wrong and got corrected rather than the code: `needsRehash(null)`
is correctly `false` — there is nothing to upgrade, and rehashing only happens after a
successful login, which an account with no hash can never reach. And flipping the last base64
character of a digest proves nothing, because trailing base64 characters can carry padding bits
that decode to the same bytes.

### Provider invites and onboarding step 1 — 2026-07-27

`invite_links` and `providers.onboarding_step` had existed since the first migration with
nothing in the app touching either. A new provider could only be created by inserting a row by
hand and running `db:set-password`.

**The invite tool** is now the first tab of `/app/admin/tools` — the only door into the system,
since there is no self-service signup and should not be: a provider is someone Keoni has met,
usually at a training course. Issuing an invite supersedes any outstanding one for the same
address, because two live tokens for one person means whichever they happen to click decides
their account and the other lingers as a loose credential.

**All five landing states are distinct**, matching v1 and for the same reason: "wrong link",
"too late", "already done" and "you have no token" need completely different actions from the
reader, and collapsing them into one error means everybody emails Keoni.

**The invite is claimed BEFORE the provider is created**, conditionally on it still being
pending. Two browsers submitting together then produce one winner and one "already used".
Creating the provider first would let both succeed and leave one account orphaned.

**The account is created `pending`, not active, with `bookingEnabled` false.** Finishing
onboarding is not consent to practise — Keoni still confirms insurance and medical-director
documents by email. Creating an active provider here would hand out booking access on the
strength of an email address.

v1's step 1 said "STEP 1 OF 5" and its sidebar omitted Medical Director, while every later
screen said "OF 6". Six is used consistently here.

### `sendEmail` distinguishes "not configured" from "failed" — 2026-07-27

Sending the first real invite surfaced this: the admin was told "Email is not configured, so
send this link yourself" when in fact Resend was configured and had rejected the address
(`example.com` is refused as a destination). Two very different problems, one message.

`sendEmail` now returns `{ delivered, reason, detail }` and no longer throws. Not throwing is
the more important half: every caller is reporting something that has ALREADY happened — a
booking made, a fee charged, an invite issued — so a failed email must never be mistaken for a
failed operation, and an exception invited exactly that.

Password rules moved to `lib/auth/password-policy.ts`. A `'use server'` file may only export
async functions, so the sync helper there was a build error TypeScript could not see — and the
form needs to import the rules anyway. One definition means a client rule the server does not
enforce, and a server rule the client does not show, are both impossible.

### Client email: what is sent, and where it can go — 2026-07-30

**Receipts are Stripe's, not ours.** `receipt_email` is set on the booking and package intents,
as training already did. Stripe's receipt carries the card's last four and a permanent hosted
URL, and a refund later produces a matching refund receipt for free. The pay page had always
asked for the address under the words "Email for your receipt" and sent none.

Requires **Settings → Business → Customer emails → Successful payments / Refunds** to be on in
the Stripe dashboard, in each mode separately. `receipt_email` alone does nothing without it.
Stripe does not send receipts in test mode at all, except to a verified team member.

**Confirmations go out when the money lands**, from the webhook — not when the booking row is
created. Confirming at creation tells somebody an appointment is theirs before they have paid
for it. A package redemption gets one too, and needs it most: no payment, no link, no receipt,
so nothing else in that flow says a word to the client.

**Cancellations are not optional.** Once somebody has been told an appointment exists they act
on it until told otherwise, so confirming without cancelling is worse than sending neither.

**Outside production, nothing reaches a stranger.** Resend has no test mode — one account, one
key, every address a real inbox — and appdev runs on a copy of production data. So:

- `MELANITE_ENV=prod` sends to the intended recipient, and ignores `EMAIL_REDIRECT_TO`
  entirely, so a stale variable cannot divert real client mail to a developer.
- Anywhere else, everything is redirected to `EMAIL_REDIRECT_TO` with the intended recipient
  moved into the subject, so a redirected message can never be mistaken for one that arrived.
- With no redirect configured, nothing is sent. Falling back to the real recipient is how a
  fresh preview environment mails clients with nothing about the setup looking wrong.
- Reserved domains (RFC 2606 / 6761) send nothing even with a redirect set. The e2e suite
  addresses its fixtures at `example.com` precisely because nothing can be delivered there;
  redirecting them turned a guaranteed no-op into real mail, and one full test run put five
  messages in a real person's inbox.

### Cherry is package-only — 2026-07-30

Cherry was offered on the booking form and should never have been. It is the one external
method where the money moves toward Melanite rather than toward the provider: the client
finances a package, Cherry pays Melanite, and Melanite then owes the provider their half.

Every other external method — Groupon, cash, cheque — is handed to the provider, who owes
Melanite its share. Marking an appointment as Cherry would have put a provider on the
collections list for money they never touched.

Removed from the picker and from the form's type. The `payment_method` enum keeps it, because
packages legitimately use it and imported v1 rows carry it.

The same distinction decides `payout_status` when a payment is recorded by hand, and lives in
`lib/payments/direction.ts` so both places read it from one list. Recording a Groupon payment as
`pending` told a provider Melanite owed them money they were already holding, and the figure
grew with every such appointment.

### Training enrolment lives in the app — 2026-07-30

The marketing site links to `app.melanitesuite.com/training`; the form is not rebuilt in
Webflow.

Card entry has to happen on a page we control — Stripe Elements on Webflow means embedding an
iframe from the app or redirecting to Checkout, so the payment leaves Webflow either way. Given
that, a second form is a second write path to keep in step, and duplicated write paths are the
v1 pattern that produced three separate ledgers.

Seat counts reinforce it: a number on a marketing page is decoration. What matters is
`claimSeat`, which takes the seat under a row lock at payment time.

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

### Room-only providers — BUILT — 2026-07-31

Some providers only rent the treatment room by the day. They bring their own clients, bill them
directly, and pay for the room out of their own pocket. Melanite never touches their client
money.

`providers.practiceType` is `laser` or `room_only` and defaults to `laser`. The onboarding flow
knows which steps apply:

- **Connect (step 4) does not apply.** It is the rail that pays a provider their share of what a
  client paid Melanite. There is no share, so the account would sit empty forever. The room
  itself is a one-off Stripe Checkout with a typed card, which needs nothing set up in advance.
- **The service menu (step 6) does not apply.** It is the Melanite laser catalogue, priced for
  the booking flow. What happens in that room never touches this system.
- **`bookingEnabled` already defaults false**, so "cannot use the laser" needed no new flag, and
  `roomRentalEnabled` already defaults true.

Numbering stays canonical for everybody and only the PATH differs, which is what lets
`onboardingStep` keep one meaning across both kinds of provider — including the nine imported
ones who all sit at 5. The DISPLAY counts only applicable steps, so a room renter sees "Step 4
of 4" rather than "Step 5 of 6" with a Connect step ticked off that they never did.

Because there is no step 6 for them, the flip to `status: 'active'` moved into the declaration
action. Missing that would have left every room renter stuck in `pending` after finishing setup.

**How medical direction is decided.**

The app cannot observe the answer — their appointments never touch this system. A bare yes/no
would ask the PROVIDER to know Idaho's supervision rules, where most will guess, and "no" is
unfalsifiable so nothing could be gated on it. So they declare what they intend to PERFORM and
the app applies Melanite's rule (`lib/room-procedures.ts`). The rule lives in one place; it is
enforceable, because a supervised declaration with no director on file closes room rental; and
it is a dated record, which a ticked box is not.

**Keoni's list, 2026-07-31:** microneedling, injections, IV therapy. Extending it is a code
change on purpose — this is medical policy and should be reviewed, not edited in a form field.

**Changeable afterwards, by design.** `setPracticeType` moves a provider either way from the
roster, so this never needs a database edit. The directions are not symmetrical: moving to
`laser` returns the account to setup at step 3 so they walk Connect and services themselves
(unless Stripe is already done), because flipping the column alone would leave somebody marked
as a laser provider with no way to be paid — which surfaces as a failed payout weeks later.
Moving to `room_only` revokes booking and keeps everything else, in case they move back.

An admin can NOT edit the declaration. It is the provider's own statement with a date on it, and
its whole value is that Melanite did not write it. The remedy for a supervised declaration is a
director on file, not a rewritten answer.

**Honest limit, worth saying to Keoni:** this records INTENT. Nothing stops somebody declaring
facials and doing fillers behind a closed door. The enforcement is her plus documents, exactly
as `bookingEnabled` is today, and no amount of software changes that.

### Training: balance reminders — 2026-07-30

A student who pays a deposit gets an enrolment email with a link to pay the balance, and Keoni
can resend that link by hand from the course page. Nothing nudges them as day one approaches.

Deliberately deferred, not forgotten: the manual path works, and the automatic one needs
infrastructure this project does not have yet.

Scope when wanted:

- A scheduled job. There is no cron in the repo at all — no GitHub Actions, no Vercel cron — so
  this is the first one, and picking where it runs is most of the decision.
- Idempotency at the reminder, not the run. A job that fires twice must not email twice, which
  means recording that a reminder was sent rather than inferring it from dates.
- The same reserved-domain and non-production guards `sendEmail` already applies. A reminder job
  is exactly the kind of thing that would quietly mail a hundred real people from a test
  environment.

The same machinery would serve appointment reminders, which nobody has asked for yet.

### Training courses have no name — 2026-07-30

A course is identified by its date. That is enough while Melanite runs one offering, and the
public page and the marketing site both call it "Laser Certification Training" as a constant.

The moment there is a second course type, `training_courses` needs a name and every screen that
says "Monday, September 14" needs to say what it is. Cheap now, awkward once there are two.

### Live seat counts on the marketing site — 2026-07-30

The Webflow page links to `app.melanitesuite.com/training`, which shows real seats-left from the
same counter the claim checks. If Keoni wants the number on the Webflow page too, that is a
small public read-only endpoint (next date, seats left) which Webflow fetches.

Display only. The authority stays with `claimSeat`, which takes the seat under a row lock at
payment time — a number on a marketing page can never be the thing that decides.

### What Melanite owes providers — 2026-07-30

Revenue shows what providers owe Melanite from Groupon, cash and cheques. The reverse — what
Melanite owes a provider from a Cherry-financed package, where Cherry pays Melanite directly —
has no summary anywhere.

Not built because there is no such data yet: no package has settled through Cherry. Worth
building when the first one does, and it is the mirror of `getOwedByProvider`.

### Nightly prod → dev copy-down — 2026-07-30

Discussed and deliberately not built before launch. Dev data would come from production, which
makes appdev genuinely representative.

The job is copy → migrate → scrub → verify, in that order, and the verify step must be able to
fail the run:

- `scrub-dev.ts` must run every time and be checked with `--check`. appdev is publicly
  reachable, and a copy-down brings real client names, emails and treatment notes straight back.
- `dev-connect-accounts.ts` must run too, or every payment path in dev breaks — imported rows
  carry live Stripe Connect ids a test key cannot see.
- Dev's schema is usually AHEAD of production, so migrations run after the restore, never
  before.

Cheapest version is a Neon branch reset, but that needs dev to be a branch of the production
project rather than its own — a one-time repoint, not a decision that has to be made now.

### `reconcileSeats` has no caller — 2026-07-30

A repair utility for `training_courses.seats_taken`, written and never wired up. The counter is
maintained by `refreshPaymentStatus`, which recomputes rather than increments, so drift should
not be possible — but if it ever happens there is no way to run the repair short of a script.

Either give it a home in the admin course page or delete it. A repair function nobody can invoke
is not a safety net.

### v1 questions still open, carried forward

- **Q-04** — package expiry default, blocked on Idaho gift-certificate law pending an attorney.
  The field exists and is deliberately left blank; a pre-filled number becomes policy.
- **Q-06** — whether a checkout discount applies to packages per-session or whole-package.
  Nothing in v2 implies an answer yet.
- **`reverse_transfer`** — refunds currently assume the provider keeps their share, which is
  what live data showed (`transfer_reversal: null`). If refunds start being issued WITH
  transfer reversal, `handleChargeRefunded` needs the proportional split instead.

### Laser hair removal by body area — BUILT — 2026-07-31

XSmall / Small / Medium / Large are retired; twelve named body areas replace them. The sizes
asked a client to classify their own body against a bracket and asked the provider to agree —
"is a Brazilian medium?" is not a question a booking page can settle, and both people already
say "Brazilian" out loud.

**Retired, not deleted.** `provider_services.service_id` is ON DELETE RESTRICT and appointments
reference the provider service, so deleting the sizes would either fail or destroy the record of
what a past client was actually treated for. `services.active = false` removes them from every
path that creates a NEW appointment — `getAvailableServices` and `getBookableServices` both
filter on it — while history keeps naming them correctly. Providers who offered one keep their
row, marked "retired by Melanite", which is the cue to add the areas they actually perform.

**Durations, from Keoni 2026-07-31.** She gave a pair for each: what it typically takes, and the
longest a provider should book. Those map onto `suggested_duration_mins` and
`max_duration_mins` — NOT both onto the default. An earlier note here said the default should be
her ceiling; that was wrong. Defaulting every back to 90 minutes would block most of a treatment
slot a day for time she said is not normally used.

| Area | Default | Max |
| --- | --- | --- |
| Back, full legs, chest, abs | 60 | 90 |
| Half legs, Brazilian | 30 | 60 |
| Upper lip, underarms, full face | 15 | 30 |

**Three areas were not in her reply** and are marked as proposed in migration 0024, so they can
be corrected without re-deriving which were guessed:

| Area | Default | Max | Basis |
| --- | --- | --- | --- |
| Half arms | 30 | 60 | old Medium bracket, alongside half leg which she timed at 30/60 |
| Full arms | 45 | 60 | between half arms and full legs |
| Bikini | 30 | 60 | smaller than a Brazilian, timed the same to be safe |

Underarms was in her durations but not her original list of areas, so it is included.

Providers set their own duration per service, so these are the defaults offered and the bounds
allowed, not a cap. **Existing providers must add the areas they perform when this goes live** —
prices cannot be carried over, because a size bracket does not map onto one area.

**Grouping.** Twelve areas took the catalogue from 15 options to 23, so `services.category`
groups both service dropdowns into `<optgroup>`s. Presentation only, nothing is gated on it, and
free text rather than an enum so adding a group is not a migration. Ordering is decided in SQL
in both queries — category, then name — because two places sorting the same list eventually
disagree. A lone group renders without a heading: "Laser hair removal" over twelve options each
named "Laser Hair Removal — …" is noise.

No LHR package template exists yet. That is not a gap in this change — it belongs with
Nichole's Groupon entry, which is the thing that needs one.

### Cherry on appointments — BUILT — 2026-07-31

Keoni asked for Cherry on all services, not only packages. Built as the client-facing option:
"Pay over time with Cherry" sits beside the card button on the appointment payment page, above
$200.

**Gated on the SERVICE price, not the total.** A tip is discretionary and 100% of it goes to the
provider, so financing one makes no sense — and letting a generous tip push a $180 service over
Cherry's floor would offer a plan Cherry then declines. The copy says the tip is not included so
nobody expects otherwise.

$200 is Cherry's own floor for writing a plan. Below it they decline, so the button would send a
client to a page that turns them down — worse than no button, because it reads as a promise the
practice could not keep. The rule is `lib/payments/cherry.ts`, shared with packages, and it
compares numerically: `money()` columns are strings, and `'90.00' >= '200'` is TRUE as a string.

**This is NOT the same as `payment_source = 'cherry'` on a booking**, which is a provider
recording money that already arrived. Keoni's earlier note — "Cherry shouldn't actually be an
option with normal bookings" — was about that dropdown, and still stands.

**No webhook exists for any of this.** The client finishes on Cherry's site, Cherry pays
Melanite, and Melanite owes the provider their half. The only signal is `cherry_started_at`,
written as they leave, and it records INTENT rather than payment. Packages and appointments now
share ONE chase list on the admin tools page — two lists would mean two places to remember to
look, and the newer one is the one that gets forgotten.

### The migration runner skipped a migration and reported success — 2026-07-31

`scripts/migrate.ts` keyed applied migrations on the SHA-256 of the file's CONTENTS. Migration
0023 adds `cherry_started_at` to `checkout_links` — byte-for-byte identical to 0018, which added
the same column before 0019 dropped it again. Same bytes, same hash, so the runner treated 0023
as already applied and printed "Nothing to apply." with exit 0.

Reporting success while changing nothing is exactly what that script's own header criticises
`drizzle-kit` for, and it would have been silent: the column would have been missing in
production, every Cherry hand-off would have thrown, and the `catch` around it swallows errors
by design so the client still reaches Cherry.

Caught by `db:verify` immediately afterwards. Fixed by keying on `hash:created_at` — the journal
timestamp is unique per entry, so the pair identifies a MIGRATION rather than a piece of SQL.
The rows written are unchanged, so `drizzle-kit` can still read the table; it compares
timestamps rather than hashes and would have applied 0023 correctly. The runner now says out
loud when it applies a file whose SQL matches an earlier one.

Worth knowing generally: any two migrations with identical SQL would have hit this. Reverting a
migration and later reinstating it is the ordinary way to produce that.

### The ETL would have erased the LHR catalogue — 2026-07-31

`scripts/etl/load.ts` TRUNCATEs `services` and repopulates it from the v1 export. Correct in
itself — the catalogue is v1 data and the loader owns it — but it erases every catalogue
decision v2 has made since, and migration 0024 is exactly that: twelve laser hair removal body
areas, four size brackets retired, everything grouped by category.

Found while writing the cutover runbook, which was about to say "apply migrations, then run the
ETL" — an order that silently undoes 0024. Production would have ended up with v1's four sizes
active, no body areas, and every category null. Migrations run once, so 0024 would never repair
it, and **nothing would fail**: the booking form would simply offer Small/Medium/Large again,
which is what it did for two years, so nobody would think to look.

Fixed by moving the catalogue decisions out of the migration's reach and into
`scripts/etl/catalogue.ts`, which is idempotent, `--check`-able and runs after every import. It
is allowed against both environments deliberately — a catalogue that differs between dev and
prod is a bug you only find in production.

Proved by breaking dev's catalogue on purpose (a size reactivated, an area deleted, categories
nulled), confirming `--check` reported all three, repairing, and re-checking clean.

The general lesson is worth keeping: **a migration is not a safe place for anything the ETL
rebuilds.** Any table `load.ts` truncates — services, provider_services, platform_settings, the
package templates — can only hold v2 decisions if something re-applies them after a load.

### Cutover runbook — docs/cutover.md — 2026-07-31

The Xano → production sequence, written to be followed at 11pm by somebody tired. Two things in
it are worth knowing even if the file is never opened:

**Xano stays running after cutover, read-only, for at least two weeks.** Neon Free keeps a
6-hour restore window, which is not a safety net for a migration run at night and inspected the
next morning. Xano is the only complete copy of the truth independent of v2, and switching it
off is the step that ends the ability to roll back — so it is last, not part of the cutover.

**Production is empty as of 2026-07-31** — 0 rows across 24 tables — and was two migrations
behind. So the cutover has genuinely not happened yet and nothing is at risk until it does.

### Field validation — 2026-07-31

`type="tel"` and `type="email"` were on most fields and doing almost nothing. `type="tel"` has
never validated anything in any browser — it picks a keypad on a phone and accepts "hello"
everywhere. `type="email"` does validate, but only on a native form SUBMIT, and the checkout,
onboarding and training forms are React-controlled with an onClick handler and no `<form>`, so
that check never ran at all. Training had its own private email regex; nothing else checked
anything beyond "not empty".

`lib/validation.ts` holds the rules, called from BOTH the form and the server action. One module
on purpose: two copies diverge the first time one is edited, and the resulting bug — a browser
that accepts what the server rejects, or the reverse — is invisible until a real person hits it.
The forms are UX; the server action is the only actual gate, which is why every rule is applied
in both places.

Choices worth keeping:

- **Phone filters keystrokes; email cannot.** There is no reason to accept a letter into a phone
  field and then explain it was wrong. Email has no illegal characters to filter, so it
  validates on blur and names the specific problem — a missing @ gets its own sentence because
  it is by far the most common.
- **Blur, then live.** Validating on every keystroke tells somebody their email is invalid while
  they are typing the third character. These wait until the field is left, then re-check on
  every keystroke so a correction clears immediately.
- **Names are length-checked only.** Every "letters only" rule ever written has told somebody
  their own name is invalid. O'Brien, Anne-Marie, Nguyễn and 李 all pass.
- **No zod.** Three field types deep, in a codebase that already hand-rolls its env parser and
  money handling. A schema library earns its place at ten times this complexity.

**The bug this turned up, which is the reason to write the browser test.** `maxLength={14}` on
the phone input looked obviously right — that is exactly `(208) 555-0134`. It truncates the RAW
value before the formatter runs, so a pasted `+1 208 555 0134` (15 characters) was clipped to
`+1 208 555 013` and formatted to `(120) 855-5013`. A plausible-looking wrong number, which is
far worse than a rejected one. The unit test passed throughout, because it called `formatPhone`
directly and never went through the field.

### Amounts and future dates — 2026-07-31

Follows the phone/email work. `type="number"` accepts `-50`, `1e9` and `0.001`, all of which
reach a server action as perfectly valid Numbers and none of which is a price.

**Server-side was in better shape than expected.** `Number.isFinite` and `<= 0` checks already
existed on services, packages, training, admin tools and the tip. The consistent gap was
**fractional cents**: money is integer cents everywhere here, so `200.005` was not rejected, it
was ROUNDED, and somebody's price silently became something they had not typed. Now refused on
service prices and course prices. What was missing on the client was any feedback at all.

`AmountField` and `IntegerField` are separate components rather than one with an option, because
the failures differ: 2.5 seats is nonsense where $2.50 is ordinary.

**Dates: only where something is being SCHEDULED.** Course dates and licence expiry cannot be in
the past. The manual booking entry and "payment received on" are deliberately left alone — they
exist to record things that already happened, and blocking past dates there would break the
feature. Licence numbers are untouched; there is no format to enforce without a rule from Keoni.

Two gaps this closed on the way past:

- **Account could set an expired licence.** Onboarding refuses one; the Account page did not —
  so the one route a provider uses AFTER setup was the one with no check.
- **`todayInDenver` existed in five copies.** Now one, in `lib/validation.ts`. It matters more
  than it looks: `new Date().toISOString().slice(0,10)` is UTC, which is a different day from
  about 5pm Denver onwards, so for the last seven hours of every working day it calls today
  "yesterday" and refuses an appointment being booked for this afternoon.

**A time bomb removed.** `test/training-courses.test.ts` used a fixture date of 2026-11-14 and
now runs against a rule that refuses past dates — so it would have passed until November 2026
and then failed every day after, with no code change. `validateCourse` takes `today` as a
parameter and the suite pins it.

**Still not validated, deliberately:** the compact inline number inputs on packages, My Services
and the enrolment payment row. Those are raw `<input type="number">` with their own layout, and
their server actions already range-check them. Converting is presentation churn, not a gap.

### BACKLOG: the nightly prod → dev copy-down — 2026-08-01

Not built. Deferred at go-live deliberately: dev drifting from production is an inconvenience,
and nothing about the cutover depends on it.

Dev and prod are separate Neon PROJECTS, so this cannot be a Neon branch — branches live inside
a project, and making dev a branch of prod would put dev's compute inside prod's 100 CU-hour
Free-plan quota, where a day of e2e runs could starve the live site. So it is an explicit
copy: export prod, load into dev.

**The job must end with these three steps or it manufactures a bug every night:**

1. `npm run db:scrub` — dev is publicly reachable at appdev.melanitesuite.com, the e2e suite
   runs against it, `EMAIL_REDIRECT_TO` points at a real inbox, and agents have full access. A
   copy brings real client names, emails, phones and treatment notes straight back. It leaves
   ids and money alone on purpose, so foreign keys resolve and the ledger still reconciles.
2. `scripts/dev-connect-accounts.ts` — the copy brings production's LIVE Connect account ids,
   which a test key cannot see at all. Every payment in dev fails with "Could not start the
   payment" until they are replaced. This already cost most of a morning once.
3. `npm run etl:catalogue` — only if the copy replaces `services`.

Have it fail loudly rather than leave dev half-scrubbed. All three are `--check`-able.

### BACKLOG: Nichole's Groupon package — 2026-08-01

A client bought a package of 6 laser hair removal sessions through Groupon and has already had
one. Nothing today can create a `client_packages` row except the Stripe webhook, which is the
whole problem.

Blocked on client details from Keoni. Needed: name, email, phone; what she paid Groupon and what
Nichole received (those differ, and the split depends on the second); purchase date, for expiry;
**which body area** the six sessions are for — "LHR package of 6" no longer identifies a service
now that sizes are retired; and how many she has already had.

Two things must exist first, neither of which needs her details: an LHR package template of 6 on
Nichole's account, and the admin entry tool — pick template, client, price paid, method, sessions
already used, writing the package, its items with `qty_used` preset, and a ledger entry with
`payment_method = 'groupon'` so `PROVIDER_ALREADY_HOLDS` treats it correctly.

### The migration runner tried to replay 0000 against production — 2026-08-01

Caught during the real cutover, on the first command aimed at production.

Two days earlier the runner was keyed on a migration file's SHA-256, and that skipped 0023
because its SQL is byte-identical to 0018. The fix was to key on `hash:created_at`. That fix was
wrong in a worse way, and only production could reveal it.

**Content is not a stable key.** Fourteen of the twenty-five migration files hash differently
now than when production applied them — line endings, mostly. Keying on hash-plus-timestamp
therefore treated all fourteen as never-applied and began replaying
`0000_normal_tarantula` against a live 24-table schema. It failed on the first statement
(`CREATE TYPE … already exists`) and migrations are only recorded once every statement succeeds,
so nothing was applied and nothing was damaged — but that was luck about statement order, not
design.

Dev could never have caught it. Dev's rows were written by this same script from these same
files, so its hashes agreed. Production's were written earlier, from a checkout whose line
endings differed. **A migration runner is only really tested against the database it has been
migrating the longest.**

Now keyed on the journal's `when`: unique per entry, never changes once written, immune to edits
and line endings, and exactly what drizzle-kit's own migrator compares on — so the table stays
readable by both. An edited migration is deliberately not re-applied; you add a new one rather
than rewriting one that has run. The runner reports which applied files no longer match what was
recorded, because that means reading the file no longer tells you what the database contains.

### A provider could not sign in, and was already signed in — 2026-08-03

Leyla reported that she had reset her password and "it just won't let me get in", with a
screenshot of a bare white 404. She was signed in. She was being bounced straight off the page.

The chain: an old bookmark to v1's `/app/login`. Webflow's `/app/(.*)` catch-all forwards every
old app URL to v2, where that path does not exist — login lives at `/login`. `proxy.ts` protects
everything under `/app/`, so she was redirected to `/login?next=%2Fapp%2Flogin`, signed in
successfully, and the login action then obediently sent her to `/app/login`.

The login action checked only that `next` was RELATIVE:

    redirect(next.startsWith('/') && !next.startsWith('//') ? next : '/app')

That stops an open redirect and nothing else. A relative path to a page that does not exist
passes happily. `lib/auth/next-path.ts` now checks against real destinations and falls back to
`/app`, which is always safe — the worst outcome is landing on the dashboard instead of the page
you wanted, which is what happened before `next` existed at all.

**The Webflow redirect exposed this; it did not cause it.** Anyone reaching `/app/login` by any
route would have hit the same wall.

**Two things made it worse than it needed to be.** There was no custom `not-found.tsx`, so the
app served Next's unstyled white default — on a phone, with no branding and no way back, that
does not read as a mistyped URL, it reads as the business being offline. And the destination
list initially covered `/app` only, while `proxy.ts` also protects `/onboarding` — so the first
version of the fix would have sent anyone signing in mid-setup to a dashboard they are not
allowed to open. The staleness test now walks every protected root rather than a hardcoded one,
because scoping it to `/app` is exactly how that gap got through.

### A four-day-old dev server looked like a regression — 2026-08-03

While fixing the above, the e2e suite fell from 73 passing to 53 and ran for eight minutes
instead of one. It looked like the change had broken sign-in across the app.

It had not. `playwright.config.ts` runs against an already-running dev server rather than
starting its own, and that server had been up since 30 July. Server actions were hanging — the
sign-in button sat on "Signing in…" indefinitely — while the database answered in 40ms.

Confirmed by attribution rather than reasoning: stashing the change and re-running reproduced
the failure on the previous code. Killing the stale process and starting a fresh server restored
72 passing in 58 seconds.

Worth remembering because the symptom is so misleading: a long-lived Next dev server degrades
into hung server actions, which present as product bugs in exactly the areas being worked on.
When a suite degrades broadly and slows down at the same time, suspect the server before the
diff.

### Marketing attribution: dropped before it was built — 2026-08-18

The consulting arrangement changed to a flat $200/month with no revenue share. The attribution
system was designed almost entirely around one property — that its output decided a contractual
payment — so removing that removes the reason for nearly all of it.

**What the money requirement was actually buying**, none of which is justified by "understand
how the site is used":

- Per-provider attribution surviving from first touch to an invite issued months later. A
  payment attaches to a person; traffic analysis does not.
- `ATTRIBUTION_START_DATE`. Existed only to stop retroactive payment on the nine providers
  imported from v1.
- Stripe metadata on every transaction — a reconciliation trail for a disputed invoice.
- Refund netting, write-offs, negative months carried forward. All about not being paid on
  money that came back.
- The untracked line, so totals reconciled against `/app/admin/revenue`.
- An admin report grouping `melanite_cut` by source. That was the invoice.
- The `provider_referral` source, and the rule that a referral does not inherit the referring
  provider's channel. Both were about who gets paid.

**Approximate is now fine, and that is the whole difference.** A channel report that is 90%
right is useful for deciding where to post. A payment that is 90% right is a dispute.

**What replaces it is already installed.** GA4 (`G-DP91MV4CKT`) has been in the Webflow header
the entire time and answers traffic, channel mix, landing pages and bounce with no bespoke code.

The one question it does not answer out of the box is the interesting one: which channels bring
people who actually enrol in training. That is cross-domain — melanitesuite.com is Webflow,
`/training` is on app.melanitesuite.com — and GA4 handles it with cross-domain measurement plus
a conversion event on the enrolment. Configuration, not code, and that is the entire remaining
scope.

**The first-touch script is removed from Webflow.** Written, deployed and verified on
2026-08-14, and now read by nothing: the app side that would consume `mlt_ft` was never built
and no longer will be. Left in place it would keep writing localStorage and hanging an opaque
base64 blob off every link to the app, for data nobody looks at. Dead capture is worse than no
capture — the next person to find it assumes something depends on it.

The UTM convention survives in `docs/marketing-attribution.md`, trimmed to what it always
actually was underneath the contract language: fixed `utm_source`/`utm_medium` pairs so a
channel is spelled one way and GA4's reports do not fragment it into four.

**Findings worth keeping, because they outlive the contract.** These came out of reading the
repo for the attribution design and are true regardless of how anyone is paid:

- **There is no landing page on the app domain.** `app/page.tsx` redirects `/` to `/app` and
  `proxy.ts` bounces a signed-out request to `/login`. The only public pages on the app host
  are `/training` and `/pay/*`. Anything that wants to observe an arriving visitor has to do it
  on Webflow or at `/training`.
- **There is no self-service provider signup, deliberately.** Providers are created by claiming
  an invite token at `app/onboard/[token]`. The funnel is marketing → `/training` → invite →
  onboard, and it can span months.
- **`training_enrollments.provider_id` is nullable** because the enrolment routinely predates
  the provider. `ledger_entries.provider_id` carries the same caveat. Anything joining a
  student to a provider has to go through `invite_link_id`, not assume the row exists.
- **Melanite revenue cannot be read from Stripe alone**, and this is the one worth remembering.
  Groupon money reaches the provider, who then owes Melanite half; Cherry pays Melanite by ACH.
  Neither creates a PaymentIntent. `ledger_entries.melanite_cut` is the only complete answer —
  tips excluded by construction, provider-paid rows unsplit, refunds as their own rows. Any
  future revenue report should start there, not at Stripe.

**Removed with this change:** Exhibit A and its Word copy, the revenue-share clauses of the
contract, and the attribution capture from the Webflow footer. The Webflow footer field is now
empty, documented in `webflow/README.md` rather than as an HTML comment in the field itself --
a comment there ships to every visitor and puts internal repo paths in view-source for no
benefit to anyone reading the page. **The field has to be cleared in Webflow and republished,
or the old code keeps running.**

### Melanite hears about its own calendar — 2026-08-19

Keoni asked to be emailed whenever an appointment is booked or cancelled, the rental room
included. Everything this app sent went to a **client** or to a **provider**; nothing at all was
addressed to the business, so the calendar changed under her without a word.
`melanitelasersuite@gmail.com`, via the existing Resend wrapper.

**Booked means the row was created, not that it was paid for.** That is deliberately the opposite
rule to `bookingConfirmedEmail`, which waits for the money — and the reasoning does not carry
over. A client must not be told an appointment is theirs before they have paid; Keoni is being
told the laser is taken, which is true the moment the row exists. Waiting for a payment would also
hide most of her calendar from her: a Groupon, cash, package or prepaid booking produces no
payment event at all.

**The room is the exception, and alerts on `confirmed`.** `startRoomRental` writes a 30-minute
`pending` hold before sending the provider to Stripe, and a hold is not a rental — it expires on
its own with nothing to announce. Alerting on it would leave an unmatched booking email behind
every abandoned checkout. Same reason the Stripe-failure rollback and `releaseExpiredHolds` send
nothing.

**Not wired up, on purpose:**

- **`createManualBooking`** (`/app/admin/tools`). Keoni is usually the person typing into it, and
  a past-dated entry lands as `completed` rather than on the upcoming calendar at all. Telling
  her about her own data entry is noise, and noise is what makes an alert stop being read.
- **`markNoShow`.** It frees the laser the way a cancellation does but it is not one, and she
  asked for booked and cancelled.
- **`refundRoomRental` / `declineRoomRefund`** in the admin queue. Those are her own decisions.

**One call site per booking path, one for every cancellation.** The three creation paths
(`/app/book`, package redemption, prepaid redemption) have no shared write function — each
re-implements the same collision-checked INSERT — so each gets its own line. Cancellation is
different: `notifyCancelled` is already the single funnel all three cancel actions pass through,
so the alert goes in there. It fires **before** that function's `if (!row?.clientEmail) return`;
a walk-in with no address still frees the laser, and that is the fact being reported.

**The address is a constant in `lib/email.ts`, not configuration.** `MELANITE_NOTIFY_EMAIL`
overrides it for a preview environment, but an unset variable must not be able to quietly switch
the alerts off — which is exactly what a required env var would do the first time somebody
forgot it in Vercel. It is one business inbox and it changes about never. A `platform_settings`
column plus an admin field would be a migration and a form for a value nobody is going to edit.

Nothing new reaches a stranger: these go through `sendEmail`, so outside `MELANITE_ENV=prod`
they are redirected to `EMAIL_REDIRECT_TO` like everything else, and with no redirect set they
are not sent at all.

**The payment line reads its direction from `PROVIDER_ALREADY_HOLDS`**
(`lib/payments/direction.ts`) rather than restating it. Groupon, cash and cheques are collected
by the provider and Melanite invoices its half back; Cherry runs the other way and pays Melanite,
which then owes the provider. An alert saying "collected by the provider" about a Cherry booking
would point an invoice at somebody who never touched the money — the same mistake that once put
providers on the collections list for Groupon revenue. A method the list has never heard of, and
a null one, claim no direction at all rather than guessing.

**If it becomes noise**, the next step is a per-event toggle in `platform_settings` — not built
now, because there is nothing to tune until she has lived with it.

The room slot labels ("Full day", "Morning", "Afternoon") moved into `lib/email.ts` and the
Stripe line item now reads them from there. Three words, two copies, and the copy in the alert
and the copy on the receipt describing the same block differently is the sort of thing nobody
notices until a provider asks which one is right.

### Production ran for ten hours without the tables its code required — 2026-08-19

The prepaid/gift-card feature merged to main and deployed. Its code went live; migrations 0025
and 0026 were never applied to production. So `prepaid_balances`, `prepaid_redemptions` and
`prepaid_checkout_links` did not exist, and 25 of 27 migrations showed as applied.

**Everything whose query MENTIONS a missing table dies; everything else keeps working.** That is
what made it hard to read. `/app/appointments` returned a server error for every provider,
because `getAppointments` runs `exists (… from prepaid_redemptions …)` on every row and
Postgres cannot plan a query against a table that is not there. Cancelling was broken for the
same reason — `cancelBooking` reads `prepaid_redemptions` as a guard before it changes
anything, so it threw first. Meanwhile the DASHBOARD was fine, because `getNextAppointment` is
deliberately a narrower shape that never touches prepaid.

The provider who reported it described exactly that split without knowing why: "It shows two
upcoming appointments but I can't actually see them." An app that is half-alive reads as a
product bug, and she reasonably assumed she had done something wrong.

Client payments were never affected. The prepaid references in `app/pay/actions.ts`,
`lib/db/queries/checkout.ts` and `lib/stripe/handlers.ts` all sit inside prepaid-only branches,
which nothing could reach because no prepaid link could exist.

**Nothing caught it and nothing structurally could have:**

- **The vitest suite runs against DEV**, which has every migration applied. A suite pointed at
  dev cannot see production schema drift, however green it is. It was green when main was
  pushed, twice, on the day this was already broken.
- **Vercel deploys code.** It has no idea a migration exists.
- `db:verify` finds it in one command and nobody had a reason to run it.

It surfaced because a provider texted Keoni, roughly ten hours in. That is the worst available
monitoring, and it is what `.github/workflows/prod-schema-check.yml` now replaces: `db:verify`
against production on every push to main, daily at 10:10 UTC, and on demand. It uses the same
read-only production role as the nightly refresh, so it is incapable of writing.

**The rule this encodes:** a merge to main that carries a migration is not finished when the
deploy is green. `MELANITE_ENV_FILE=.env.migration npm run db:migrate` is part of shipping it,
and `db:verify` is how you know. `db:migrate`, never `db:migrate:kit` — 0025 contains
`ALTER TYPE … ADD VALUE`, which is the 55P04 case above.

Worth noting what did NOT go wrong: the migration runner, rewritten twice already, applied both
files correctly on the first attempt — all 25 statements, keyed on the journal's `when`. The
gap was never the tool. It was that nothing asked the question.
