# Split → rental cutover

**Wednesday 21 October 2026.** The day Melanite stops handling clients' money entirely and
charges every provider rent instead.

Separate from `cutover.md`, which is the Xano → v2 migration and already happened. Same house
style: every step has a command and an expected output, because this is read by somebody who has
other things on their mind.

**The single most important thing on this page:** nobody can book until they have a card on file
AND have accepted the terms. That is nine people doing two minutes each, and if it is discovered
on the morning rather than arranged beforehand, the calendar is shut until they do it.

> **This page was rewritten on 19 October.** The arrangement changed four times between 7 and 19
> October and the old runbook described none of the current one — it still said the fee was taken
> "the moment a slot is reserved", which stopped being true on the 9th. If you are holding a
> printout from last week, throw it away.

---

## What actually changes

Providers bill their own clients, at their own prices, on their own systems. Melanite charges a
rental fee per session to a card on file, **taken about twelve hours after the session ends** —
not at booking. Nothing of a client's ever passes through Melanite again.

Four things that arrived after the first draft of this page and change what you do on the day:

- **Packages and prepaid are gone**, for everybody. The tables and the ledger rows stay, because
  real clients paid real money; only the feature goes.
- **Three providers are on `keoni_sets`** — Leyla, Brittany, Karly. Melanite works out **no fee**
  for them. They send Keoni what they charged their client, with a receipt, and she sets what
  they owe per appointment from `/app/admin/queue`.
- **The fee schedule is what Melanite NETS.** Stripe's cut is priced on top, so a $60 tier
  charges the card $62.11. Providers see the charged figure when they book.
- **Terms are at v5**, and two of the v3 terms had quietly become false. Everybody re-accepts.

**Bookings made BEFORE cutover keep their old terms.** Rent is only ever charged against a
`payment_source = 'rental'` booking, and an appointment that already exists cannot acquire one.

---

## 0. Before the day

### 0.1 Tell the providers — the only step with human lead time

Three things block booking, all self-service, none of them fixable on Wednesday morning:

| | Who | Where |
|---|---|---|
| A card on file | everybody; **the three have none today** | `/app/account` → Equipment rental |
| Accept terms v5 | all nine | same screen, same visit |
| Nothing else | — | — |

Worth saying in the same message: **the amount on their card includes card processing**, so it is
a little above the published fee. That is a change in what they pay and they will see it on a
statement; better from Keoni than discovered.

The three on `keoni_sets` need one extra sentence: **they will not see a price when they book**,
and they send Keoni the receipt afterwards.

### 0.2 The live Stripe webhook — ✅ done 7 October

```bash
stripe webhook_endpoints list --live
```

Confirm the live endpoint takes `payment_intent.succeeded`, `charge.refunded`,
`checkout.session.completed`, and the invoice and subscription events.

> `payout.*` and `account.updated` no longer matter — nothing is paid out. They are harmless if
> still subscribed. See **What the $604.50 is not**, below.

### 0.3 Confirm the write key in Vercel is live

Saving a card needs SetupIntents read, PaymentMethods read **and** Customers write. Charging
needs PaymentIntents write. The redirect back from Stripe looks identical whether or not the card
actually saved, so this is proved in step 7 and nowhere else.

### 0.4 Settle what the old model left behind

Two piles, and only the second is urgent.

**Fifteen pending payment links, $1,510, none of them paid.** Thirteen have already expired, so
they are unpayable today and closing them changes nothing. Keoni's account is that the girls
mostly settle over Venmo, so most were paid months ago outside the app.

```bash
MELANITE_ENV_FILE=.env.migration npm run close-stale-links
MELANITE_ENV_FILE=.env.migration npm run close-stale-links -- --apply --i-know-this-is-production
```

It closes only the expired ones and names the live ones it is leaving alone. **It records no
payment** — a figure that was assumed is worse than a gap that is visible. If Keoni wants a
specific one recorded as collected, Tools → Record a payment does it against her own CSV.

**Karly is owed nine sessions.** Her clients bought them under the old model, where Melanite
already took its half at the point of sale. Charging her rent to deliver them charges twice.

```bash
MELANITE_ENV_FILE=.env.migration npm run cutover:grant-sessions
MELANITE_ENV_FILE=.env.migration npm run cutover:grant-sessions -- --apply
```

Expect `Karly Dettorre  lhr_small  9 sessions`. **The number is computed, never typed** — it was
11 when first discussed and 9 now, because some got worked in between.

### 0.5 Retire Nichole

She has left Melanite and is kept as the test account the Playwright suite signs in as.

```bash
MELANITE_ENV_FILE=.env.migration npm run retire-provider -- --email nichole.mim@gmail.com
MELANITE_ENV_FILE=.env.migration npm run retire-provider -- --email nichole.mim@gmail.com -- --apply --i-know-this-is-production
```

Inactive, booking off, room rental off. **Nothing is deleted** — appointments, ledger rows and
end-of-use checklists all reference her id.

> This shuts the booking gates for `E2E_PROVIDER_EMAIL`, and every nightly refresh from now on
> imports an account that cannot book. `npm run dev:after-refresh` reopens them. If the suite
> ever fails at `auth.setup.ts`, that is the first thing to check.

### 0.6 What the $604.50 is not

Eleven ledger rows sit at `payout_status = 'pending'` — Leyla $445.00, Karly $159.50, oldest
10 August. **It is not a debt and nobody should be paid it.**

Those were destination charges: `transfer_data.destination` moves the provider's share into their
connected account as part of the charge itself. They were paid at the time. `payout_status` tracks
a different event — Stripe paying that balance out to *their* bank — and Melanite is not
subscribed to it. All eighteen `payout.paid` events ever received carry no `account` field, so
every one is the platform's own payout and `handlePayout` returns at its first line.

Confirm against the Stripe dashboard (Connect → those two accounts → payout history), then mark
the rows paid. The ledger invariant test prints the figure on every run until it is cleared.

---

## 1. Snapshot

```bash
# Neon → the production project → Branches → create a branch from main
```

Named for the date. This is the rollback, and the only one that covers data.

---

## 2. Schema first

Every migration is **additive or permissive** — new columns defaulting to null, and one enum
value renamed in place. They can go on before the new code, and the window where the two disagree
is zero.

```bash
MELANITE_ENV_FILE=.env.migration npm run db:migrate
MELANITE_ENV_FILE=.env.migration npm run db:verify
```

Expect `0032` through `0046` applied, then `Schema verified.`

> **0044 renames an enum value** (`half_own_price` → `keoni_sets`) with
> `ALTER TYPE ... RENAME VALUE`. It rewrites the label in place, so every row carrying it moves
> with it and there is no window where some providers are on the old name. It is the one
> migration that is not purely additive, and it is still safe before the deploy because no
> deployed code reads that column yet.

> `db:verify` compares production against the **working tree**. Run it from the rental branch or
> it reports tables that do not exist yet and looks like a disaster.

---

## 3. The catalogue

`etl:load` truncates `services`, which is why this is a re-runnable script and not a migration.

```bash
MELANITE_ENV_FILE=.env.migration npm run etl:catalogue
```

The generic `IPL` and the parenthesised size names are **retired, not deleted** — past
appointments reference them and the record of what a client was treated for has to survive.

> Those retired names are why some of Nichole's old sessions cannot be priced automatically: they
> point at services the tier guide no longer knows. Keoni sets those by hand if they ever need
> billing.

---

## 4. The fee schedule

```bash
MELANITE_ENV_FILE=.env.migration npm run etl:rental-fees
```

Expect `Schedule v1 published with 19 tiers`. It **only ever seeds** — once a schedule exists the
database is the source of truth and the constants are a fallback for a tier added in code later.

**These figures are what Melanite NETS.** `platform_settings.stripe_fee_pct` (0.029) and
`stripe_fee_fixed_cents` (30) are added on top at charge time. Leave them alone on the day; see
**Setting the processing rate**, below.

---

## 5. Move everybody onto rent

```bash
MELANITE_ENV_FILE=.env.migration npm run cutover:revenue-models
MELANITE_ENV_FILE=.env.migration npm run cutover:revenue-models -- --apply
```

Expect every active non-house provider on `rental`, and Leyla, Brittany and Karly on
`keoni_sets`. It warns loudly about anybody who can book and has no card.

**Run this AFTER the deploy, not before.** It is the one data step that changes how a provider is
treated rather than adding something unread, and the currently deployed code does not understand
`keoni_sets`.

---

## 6. Set the review start date

`REVIEW_STARTED_AT` in `lib/rental/review.ts` is the day a session that did not happen becomes
Keoni's decision rather than history. Set it to the cutover date before deploying, or every
cancelled appointment in the archive lands in her queue at once.

---

## 7. Deploy

Environment variables apply at **build** time, so a redeploy rebuilds the old commit. Push.

```bash
git checkout main && git merge Ethan/rental-fee-model && git push
```

No new environment variables are needed, which is worth saying plainly because it is the step
people expect to need them.

> `BLOB_READ_WRITE_TOKEN` is already set — receipts use the same store as equipment photos,
> under a `receipts/` prefix.

Then run step 5.

---

## 8. The canary

**Do this before telling anyone else to.** Add a card as yourself or Keoni, then:

```bash
MELANITE_ENV_FILE=.env.migration npx tsx --tsconfig scripts/tsconfig.json scripts/sql.ts \
  "select email, billing_card_last4, rental_terms_version, rental_schedule_version
     from providers where billing_payment_method_id is not null"
```

A row with a last four and both versions set means the webhook works in production **and** that
the restricted key carries SetupIntents read, PaymentMethods read and Customers write — saving a
card is all three. Nothing else proves any of it.

If that row is empty, **stop**. Nobody else should hand over a card until it is explained.

---

## 9. The other eight

Each needs, on `/app/account`: a card, and the terms accepted. Watch the roster — the **Card**
column shows `none on file — cannot book` until they have.

```bash
MELANITE_ENV_FILE=.env.migration npx tsx --tsconfig scripts/tsconfig.json scripts/sql.ts \
  "select first_name, rent_basis, booking_enabled, billing_card_last4, rental_terms_version
     from providers where status='active' and revenue_model <> 'house' order by first_name"
```

The three on `keoni_sets` will show a null `rental_schedule_version` for ever and that is
correct — they are exempt from accepting a price list that governs nothing they pay.

---

## 10. Smoke test, in this order

1. **Sign in as an ordinary provider.** Book something — the fee is on the button before it is
   pressed, and it is the **grossed-up** figure. Check it against `/app/admin/pricing`: the
   schedule says $60, the button says $62.11.
2. `/app/charges` shows the charge against the right service, at the charged amount.
3. **Cancel it inside 24 hours.** It asks **what happened** and will not proceed without an
   answer. The fee is **held, not refunded**.
4. `/app/admin/queue` — the session is there with what you typed. Press **Charge**. Check the
   provider gets the outcome email, then do another and press **Don't charge it**: nothing moves,
   the item leaves the queue, and they are still emailed.
5. **Mark a past session a no-show.** Same question, same hold.
6. **Sign in as Leyla.** Book — there is **no price anywhere**, and the button says
   "Book appointment". After the session, the card asks what she charged; send $150 with a photo.
7. `/app/admin/queue` — the item says *"They charged their client $150.00"* with a **See the
   receipt** link. Type a figure, charge it, and confirm the receipt link stops working
   afterwards — it is deleted once the session is settled.
8. `/app/admin/calendar` — block an hour, confirm it greys out for a provider.
9. `/app/admin/pricing` — publish a change, confirm an ordinary provider is asked to accept it
   and **Leyla is not**.

If any of these reports *"Melanite could not take the rental fee"* rather than a card problem, it
is a scope on the restricted key, not the provider. The exact permission is in the Vercel function
log, logged by `[rental] charge FAILED`.

---

## Setting the processing rate

Not a day-one step. `stripe_fee_pct` defaults to Stripe's US standard, which is right for a
domestic card and low for Amex or an international one — so Melanite under-recovers on those
until it is raised, and over-recovers on ordinary cards once it is.

The evening digest reconciles every recent charge against what Stripe **actually** took and
reports the drift. After a week of real charges:

```bash
MELANITE_ENV_FILE=.env.migration npx tsx --tsconfig scripts/tsconfig.json scripts/sql.ts \
  "select count(*), sum(stripe_fee_cents), round(sum(stripe_fee_cents) / (sum(gross_amount) * 100), 4) as effective
     from ledger_entries
    where source = 'rental_fee' and entry_type = 'purchase' and stripe_fee_cents is not null
      and created_at > now() - interval '30 days'"
```

Set the rate from that number, not from a guess. Positive drift in the digest means money taken
from providers that Stripe did not charge, which is the direction worth watching.

---

## Still live on purpose

- **`/pay/[token]`.** Two payment links are still payable: janea's on 22 October ($60) and
  whichever of Leyla's has not lapsed. Removing the route makes them 404. Close them with
  `close-stale-links -- --include-live` once they are settled or converted, and the whole Connect
  path can go in one commit after that.
- **`/app/services`.** Unlinked from every menu, still reachable by URL. It fed the old
  half-their-own-price derivation, which is gone; nothing reads it now.
- **`provider_share_pct`.** Still 0.500 and still used by the digest's "to collect" figure for
  pre-cutover external bookings. Changing it silently changes what Keoni invoices for those.

---

## Rollback

**Before step 7**, free: the schema changes are additive and the deployed code ignores them. The
enum rename in 0044 is the one exception, and reverting it is a one-line
`ALTER TYPE ... RENAME VALUE` back.

**After step 7**, revert the merge and push. The schema can stay — old code does not read the new
columns.

**What does not roll back is money.** Any rental fee charged between deploy and rollback is a real
charge on a provider's card. Refund it from `/app/charges` by cancelling the booking, or from
Stripe directly, and note that the ledger keeps both rows: a refunded fee is "charged and given
back", which is a different fact from "never charged".

**Receipts do not roll back either.** A receipt uploaded and then deleted on settlement is gone
from the blob store; the amount and the timestamp survive on the booking.
