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
production, `STRIPE_SECRET_KEY_WRITE` must be a **live** key. From cutover it starts *debiting*
providers; until now it has only ever credited Melanite, so this is the first time a mistake here
costs somebody else money.

### 0.4 Two decisions that are not technical

- **Does a cancellation refund the fee?** It does today. Keoni asked only for no-shows; a late
  cancellation leaves a hole in the day that rarely gets filled, so there is an argument for
  keeping it. One line in `lib/rental/release.ts` either way.
- **Tell the providers.** They cannot book until they have added a card. Whether they hear that
  before or after the deploy is a business call, but somebody has to make it.

### 0.5 Not blocking, but has a deadline

Twelve appointments from July–September have no payment recorded — **$1,200**, nine of them
Nichole's. They may well have been paid outside the app and never entered. Keoni has the list
(`unrecorded-payments.csv`). This does not block cutover, but **removing the client-payment code
makes it uncollectable**, so settle it before step 6.

---

## 1. Snapshot

```bash
# Neon → the production project → Branches → create a branch from main
```

Named for the date. This is the rollback, and the only one that covers data.

---

## 2. Schema first

All six migrations are **additive or permissive** — new tables, a new enum value, columns that
default to null, and CHECK constraints that only apply to `payment_source = 'rental'`, which the
currently deployed code never writes. So they can go on before the new code, and the window where
the two disagree is zero.

```bash
MELANITE_ENV_FILE=.env.migration npm run db:migrate
MELANITE_ENV_FILE=.env.migration npm run db:verify
```

Expect `0032` through `0037` applied — six — then `Schema verified.`

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

A row with a last four and both versions set means the webhook works in production. Nothing else
proves it — the redirect back looks identical whether or not the card saved.

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
3. Cancel it. The fee comes back, and the appointment reads `rent refunded`.
4. `/app/admin/calendar` — block an hour, confirm it greys out for a provider.
5. `/app/admin/pricing` — publish a change, confirm the provider is asked to accept it.

---

## Do NOT, until 20 October

- **Change `provider_share_pct`.** It is 0.500 and the digest computes the "to collect" figure for
  the eight external bookings from it. Changing it silently changes what Keoni invoices.
- **Remove the client-payment code.** `/pay`, packages, prepaid and `/app/services` are unlinked
  from the provider menu but still work. The last pre-cutover appointment is **20 October**.
- **Cancel and rebook an existing appointment.** Cancelling frees the slot; rebooking creates a
  *rental* booking and charges rent — for a client who already paid by Groupon. Moving one of the
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
