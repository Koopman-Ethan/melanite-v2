# Split → rental cutover

The day Melanite stops taking clients' money and starts charging providers rent.

Separate from `cutover.md`, which is the Xano → v2 migration and already happened. Same house
style: every step has a command and an expected output, because this is read by somebody who has
other things on their mind.

**The single most important thing on this page:** nobody can book until they have a card on file
AND have accepted the terms. That is five people doing two minutes each, and if it is discovered
on the morning rather than arranged beforehand, the calendar is shut until they do it.

---

## What actually changes

Providers bill their own clients, at their own prices, on their own systems. Melanite charges a
rental fee per session to a card on file, taken the moment a slot is reserved.

**Bookings made BEFORE cutover keep their old terms.** `chargeRentalFee` is only ever called from
`createBooking`, so an appointment that already exists cannot acquire a rental fee. The eight
external bookings running to 20 October still appear in Keoni's "to collect" list and are still
settled at the old 50/50. That is automatic — no step below makes it true.

---

## 0. Before the day

### 0.1 The live Stripe webhook — ✅ done 7 October

Card setup is saved by `checkout.session.completed`, not by the redirect back. That event was
subscribed on one of v1's **disabled** Xano destinations and not on v2's, so a provider would have
completed Stripe's page and had nothing saved, silently.

Re-check any time — the restricted read key now carries `webhook_read`:

```bash
# lists live destinations and which events each one takes
npx tsx --tsconfig scripts/tsconfig.json scripts/stripe-webhooks.ts
```

Expect `ENABLED app.melanitesuite.com/api/webhooks/stripe`, `checkout.session.completed: YES`, and
nothing missing. The three Xano destinations should stay DISABLED.

### 0.2 Rehearse on appdev

`appdev` tracks `dev`, which does **not** have this work yet. Merge first, or there is nothing to
rehearse:

```bash
git checkout dev && git merge Ethan/rental-fee-model && git push
```

Then on appdev, as a provider with no card: add one, accept the terms, book, cancel, book again,
mark a no-show. Appdev is test mode, so a real card save can be proven there — on production it
cannot be, until the first real one.

### 0.3 Confirm the write key in Vercel is live

```bash
npx tsx --tsconfig scripts/tsconfig.json scripts/stripe-account.ts
```

This prints the LOCAL keys, and locally the write key is a sandbox **on purpose** — it is why
nothing run from a laptop can charge anybody, even with `.env.migration` loaded. The script says
so rather than reporting it as a fault.

**The deployed key is the one that matters and cannot be checked from here.** In Vercel →
production, `STRIPE_SECRET_KEY_WRITE` must be a **live** key. From cutover it starts _debiting_
providers; until now it has only ever credited Melanite, so this is the first time a mistake here
costs somebody else money.

That it is live is not in doubt — live payment intents and payouts exist, which a test key cannot
produce. **Its SCOPES are the open question**, because it is a _restricted_ key (`rk_live`) and the
rental code calls five endpoints the old code never did:

| Call                                | Where                           | Needs                    |
| ----------------------------------- | ------------------------------- | ------------------------ |
| `GET /setup_intents/{id}`           | `lib/stripe/billing-card.ts:58` | SetupIntents **read**    |
| `GET /payment_methods/{id}`         | `billing-card.ts:75`            | PaymentMethods **read**  |
| `POST /customers/{id}`              | `billing-card.ts:80`            | Customers **write**      |
| `POST /payment_methods/{id}/detach` | `billing-card.ts:122`           | PaymentMethods **write** |
| `POST /refunds`                     | `lib/rental/charge.ts:391`      | Refunds **write**        |

`POST /payment_intents` is the sixth. The code has called it since v2 shipped, but **off-session,
against a saved card, is new** — and off-session is the mode that matters now.

"Payments have been working" proves none of these. Each is a different permission, and a missing
one answers 403 with the exact permission named in the message.

**Nothing needs to be checked by hand.** Steps 7 and 9 exercise all six, in an order that stops
before anybody else is affected — adding the canary card hits the first three, booking hits
payment intents, cancelling hits refunds, and replacing a card hits detach. If a scope is missing,
that is where it surfaces, which is why step 7 says to stop rather than carry on.

A 403 no longer reads as a card problem. `isCardDecline` (`lib/rental/charge.ts`) separates a card
refusing from Stripe refusing us, so a missing scope tells the provider Melanite could not take the
fee and asks them to report it, instead of sending them to their bank about Melanite's API key.

### 0.4 Two decisions that are not technical

- ~~**Does a cancellation refund the fee?**~~ **Answered 7 October, and built.** Neither a
  cancellation nor a no-show refunds anything by itself. The provider says what happened, the fee
  is held, and Keoni decides from `/app/admin/queue`. Her words: *"sometimes its the clients
  fault, and not the providers."* See **The held-rent review** below — it changes what the
  providers have to be told.
- **Tell the providers.** They cannot book until they have added a card. Whether they hear that
  before or after the deploy is a business call, but somebody has to make it.

### 0.5 Not blocking, but has a deadline

Twelve appointments from July–September have no payment recorded — **$1,200**, nine of them
Nichole's. They may well have been paid outside the app and never entered. Keoni has the list
(`unrecorded-payments.csv`). This does not block cutover, but **removing the client-payment code
makes it uncollectable**, so settle it before step 6.

---

## 0.6 The held-rent review

Added 7 October, after the runbook was first written. It changes three things on the day.

**Every provider must accept the terms again.** `RENTAL_TERMS_VERSION` went to `2026-10-07.v3`,
because v2 told them in as many words that marking a no-show got their money back. A provider
still holding that belief would plan around it. Re-acceptance is already enforced — nobody can
book until they have accepted the current version — so this costs one extra click on the same
screen they are already visiting for their card. **It does not need a separate round of chasing,
but it does mean step 8 is not optional for anybody.**

**No money comes back on its own any more.** A cancellation or a no-show holds the fee and puts
the session in Keoni's queue with the provider's own account of what happened. She refunds it or
lets it stand, and the provider is emailed either way. Nothing else in the system can refund a
rental fee.

**She has to work the queue.** This is the part with no technical safeguard. Every cancellation
and every no-show now waits on her, where before it settled itself, so the volume is ordinary
rather than exceptional. Two things carry the prompt:

- the desk email, which gains `needs your decision` in the subject and a link straight to the
  queue instead of the calendar;
- `/app/admin/queue`, which shows the oldest first and how many days each has waited.

A provider whose fee is held has paid for a session they did not get and has been told they will
hear. **If nobody works the queue, that is money sitting in Melanite's account with somebody
waiting on it** — which is worse than the old automatic refund, not better. Worth saying to her
plainly before the day rather than discovering it a fortnight in.

> The eight pre-cutover external bookings are **not** affected. They hold no rent, so cancelling
> one never asks for a reason and never reaches the queue.

---

## 1. Snapshot

```bash
# Neon → the production project → Branches → create a branch from main
```

Named for the date. This is the rollback, and the only one that covers data.

---

## 2. Schema first

All seven migrations are **additive or permissive** — new tables, a new enum value, columns that
default to null, and CHECK constraints that only apply to `payment_source = 'rental'`, which the
currently deployed code never writes. So they can go on before the new code, and the window where
the two disagree is zero.

```bash
MELANITE_ENV_FILE=.env.migration npm run db:migrate
MELANITE_ENV_FILE=.env.migration npm run db:verify
```

Expect `0032` through `0038` applied — seven — then `Schema verified.`

> `db:verify` compares production against the **working tree**. Run it from the rental branch or
> it reports tables that do not exist yet and looks like a disaster.

---

## 3. The catalogue

`etl:load` truncates `services`, and this is also where the IPL split lives. Both reasons it has
to be a re-runnable script rather than a migration.

```bash
MELANITE_ENV_FILE=.env.migration npm run etl:catalogue
```

Expect six services added — `IPL — Full Face`, `— Neck`, `— Chest`, `— Hands`,
`ClearLift — Neck`, `— Hands` — and the generic `IPL` **retired, not deleted**: three past
appointments reference it and the record of what a client was treated for has to survive.

---

## 4. The fee schedule

```bash
MELANITE_ENV_FILE=.env.migration npm run etl:rental-fees
```

Expect `Schedule v1 published with 19 tiers`. It **only ever seeds** — if a schedule already
exists it does nothing, because from that point the database is the source of truth and the
constants are only a fallback for a tier added in code later.

---

## 5. Honour what clients already paid for

```bash
MELANITE_ENV_FILE=.env.migration npm run cutover:grant-sessions            # dry run
MELANITE_ENV_FILE=.env.migration npm run cutover:grant-sessions -- --apply
```

Expect Karly, around ten sessions of `lhr_small`. **The number is computed, never typed** — it was
11 when this was first discussed and 10 a fortnight later, because one got worked in between.

Her clients bought those sessions under the old model, where Melanite already took its half at the
point of sale. Charging her rent to deliver them would be charging twice.

It will also **refuse** any service with no published fee and **report** prepaid dollar balances
rather than guessing what a dollar buys. Production had none at the last check; if one has
appeared, it needs Keoni, not a default.

---

## 5.5 Set the review start date

`REVIEW_STARTED_AT` in `lib/rental/review.ts` is the day a session that did not happen becomes
Keoni's decision. **Set it to the cutover date and commit that before deploying.**

Left at its dev value, her queue opens on **seventeen** old cancellations belonging to the three
grandfathered providers — back to 10 August, $812.88 of Melanite's half — none of which anybody
was asked about at the time and all of which were settled between her and the provider months
ago. A queue that opens with a pile of unanswerable decisions is one she stops opening, and the
whole design rests on her working it.

```bash
MELANITE_ENV_FILE=.env.migration npx tsx --tsconfig scripts/tsconfig.json scripts/sql.ts   "select p.first_name, count(*), min(b.start_time)::date
     from bookings b join providers p on p.id = b.provider_id
    where p.revenue_model = 'split' and b.status in ('cancelled','no_show')
    group by 1 order by 2 desc"
```

Whatever that returns is what she inherits if the date is wrong. It is a compiled-in constant,
the same known limitation as `END_OF_USE_STARTED_AT` — one date for every environment.

---

## 6. Deploy

Environment variables apply at **build** time, so a redeploy rebuilds the old commit. Push.

```bash
git checkout main && git merge Ethan/rental-fee-model && git push
```

No new environment variables are needed. That is worth saying plainly, because it is the step
people expect to need them.

---

## 7. The canary

**Do this before telling anyone else to.** Add a card as yourself or Keoni, then:

```bash
MELANITE_ENV_FILE=.env.migration npx tsx --tsconfig scripts/tsconfig.json scripts/sql.ts \
  "select email, billing_card_last4, rental_terms_version, rental_schedule_version
     from providers where billing_payment_method_id is not null"
```

A row with a last four and both versions set means the webhook works in production **and** that
the restricted key carries SetupIntents read, PaymentMethods read and Customers write — saving a
card is all three. Nothing else proves any of it: the redirect back looks identical whether or not
the card saved.

If that row is empty, **stop**. Nobody else should hand over a card until it is explained.

---

## 8. The other four

Each needs, on `/app/account`: a card, and the rental terms accepted. Watch the roster — the
**Card** column shows `none on file — cannot book` until they have.

```bash
MELANITE_ENV_FILE=.env.migration npx tsx --tsconfig scripts/tsconfig.json scripts/sql.ts \
  "select first_name, booking_enabled, billing_card_last4, rental_schedule_version
     from providers where status='active' and revenue_model <> 'house' order by first_name"
```

---

## 9. Smoke test, in this order

1. Sign in as a provider. Book something — the fee is on the button before it is pressed.
2. `/app/charges` shows the charge against the right service.
3. Cancel it. It now asks **what happened** and will not proceed without an answer. The fee is
   **held, not refunded** — check the wording says so.
4. `/app/admin/queue` — the session is there with what you typed. Press **Refund**. This is the
   only step that proves Refunds write, and if it fails every earlier booking is already charged.
   Check the provider gets the outcome email, then do another and press **The fee stands**:
   nothing moves, the item leaves the queue, and they are still emailed.
5. Mark a past session a no-show. It asks the same question and holds the fee the same way —
   **this is the one that used to refund silently**, so it is the one most worth seeing.
6. `/app/admin/calendar` — block an hour, confirm it greys out for a provider.
7. `/app/admin/pricing` — publish a change, confirm the provider is asked to accept it.
8. Replace the canary's card with itself. Last of the six scopes — PaymentMethods write, for the
   detach. Least urgent of them: nobody is blocked by it, it just fails later and alone.

If any of these reports _"Melanite could not take the rental fee"_ rather than a card problem, it
is a scope on the restricted key, not the provider. The exact permission is in the Vercel function
log, logged by `[rental] charge FAILED`.

---

## Do NOT, until 20 October

- **Change `provider_share_pct`.** It is 0.500 and the digest computes the "to collect" figure for
  the eight external bookings from it. Changing it silently changes what Keoni invoices.
- **Remove the client-payment code.** `/pay`, packages, prepaid and `/app/services` are unlinked
  from the provider menu but still work. The last pre-cutover appointment is **20 October**.
- **Cancel and rebook an existing appointment.** Cancelling frees the slot; rebooking creates a
  _rental_ booking and charges rent — for a client who already paid by Groupon. Moving one of the
  eight goes through Keoni.

---

## After the 20th — the removal

A single revertible commit: `/pay`, `app/app/packages`, `app/app/prepaid`, `app/app/services`,
`account/payouts.tsx`, `account/stripe-actions.ts`, the Connect columns, and the "Payout deposited"
notification preference.

**Nine e2e specs go red** — `package-link`, `package-redemption`, `payment-link-resend` and parts
of `booking-journey` and the a11y suites. They test flows that will not exist. Expect the test
count to fall, which is the one time that is correct.

**Retire `Reserved — Melanite`**, the inactive service created on 5 October to block laser time
before `blocked_time` existed. Blocked time is a real feature now.

---

## Rollback

**Before step 6**, free: the schema changes are additive and the deployed code ignores them.

**After step 6**, revert the merge and push. The schema can stay — old code does not read the new
tables.

**What does not roll back** is money. Any rental fee charged between deploy and rollback is a real
charge on a provider's card. Refund it from `/app/charges` by cancelling the booking, or from
Stripe directly, and note that the ledger keeps both rows: a refunded fee is "charged and given
back", which is a different fact from "never charged".
