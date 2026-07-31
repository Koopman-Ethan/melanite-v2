# Xano → production cutover

The one-time migration from v1 (Xano + Webflow + Wized) to v2, and what happens either side of
it. Written to be followed at 11pm by somebody tired, so every step has a command and an
expected output rather than an instruction to "check that it worked".

**The single most important thing on this page:** `etl:load` truncates the service catalogue.
Step 3.2 puts it back. Skipping it is silent — nothing fails, the booking form just quietly
offers Small/Medium/Large again, which is what it did for two years, so nobody thinks to look.

---

## 0. Before the night

### Credentials you need in hand

| What | Where it goes | Notes |
| --- | --- | --- |
| Production `DATABASE_URL` | `.env.migration` | must sit beside `MELANITE_ENV=prod` in the same file |
| `XANO_PAT` | `.env.migration` | Metadata API token, **read-only** |
| `STRIPE_SECRET_KEY` | `.env.migration` | **restricted** `rk_live_…`, read scopes only |

`MELANITE_ENV` is stated, never inferred. A branch name says where the code is, never where the
data is — see `lib/env-guard.ts` for why every cheaper guard was rejected.

Every command below that touches production is prefixed `MELANITE_ENV_FILE=.env.migration`.
Without it you are talking to dev, which is the safe failure.

### Rehearse on dev first

The whole sequence runs against dev with no opt-in flags. Do it end to end at least once in
daylight. A rehearsal that works is worth more than a runbook that reads well.

```bash
npm run etl:stage
npm run etl:manifest        # read the output, do not skim it
npm run etl:load -- --force
npm run etl:catalogue
npm run etl:verify
npm run db:scrub            # dev only — see step 6.3
npx tsx --tsconfig scripts/tsconfig.json scripts/dev-connect-accounts.ts
```

### Confirm where production actually stands

```bash
MELANITE_ENV_FILE=.env.migration npm run db:verify
```

Expect `Schema verified.` and a row count. If it says **"Do not load data into this database"**,
that is the gate doing its job — go to step 1.

---

## 1. Schema first

Migrations must be applied **before** any data, because the loader inserts against the schema it
finds.

```bash
MELANITE_ENV_FILE=.env.migration npm run db:migrate
MELANITE_ENV_FILE=.env.migration npm run db:verify
```

Expect `Applied N migration(s).` then `Schema verified.` with all seven checks `ok`.

If `db:migrate` says **"Nothing to apply"** but `db:verify` still fails, do not shrug and
continue — that combination is a real bug this runner had once, where a migration whose SQL was
byte-identical to an earlier one was treated as already applied. It is fixed, and the runner now
announces when it applies repeated SQL, but the symptom is worth recognising.

Do not proceed until `db:verify` is clean.

---

## 2. Stage — reads only, writes nothing

```bash
MELANITE_ENV_FILE=.env.migration npm run etl:stage
MELANITE_ENV_FILE=.env.migration npm run etl:manifest
```

`stage.ts` pulls Xano and Stripe into `scripts/etl/staged/`. It touches no database and can be
re-run freely.

`manifest.ts` reports every row it will keep or drop, **and why**, before anything is written.
Read it. The point of a migration is that it is boring: everything it does should have been
visible beforehand. A previous loader silently dropped $1,632 of package transactions and three
redemptions — the outcome happened to be right, and nobody chose it.

> `staged/` holds real client names, phone numbers, email addresses and treatment notes. It is
> gitignored and must stay that way. Reproducibility comes from `stage.ts` being re-runnable,
> not from committing the data.

---

## 3. Load

### 3.1 The data

```bash
MELANITE_ENV_FILE=.env.migration npm run etl:load -- --i-know-this-is-production
```

Two independent statements are required against production: `MELANITE_ENV=prod` **and** the
flag. Either alone is something a person can do without noticing — an env file left over from
yesterday, or a flag copied out of a runbook.

If the ledger already has rows it refuses and tells you to add `--force`. On a genuine first
load it will not need it. If it does, stop and work out why there is data.

### 3.2 The catalogue — DO NOT SKIP

```bash
MELANITE_ENV_FILE=.env.migration npm run etl:catalogue
```

`etl:load` TRUNCATEs `services` and repopulates it from v1. That is correct — the catalogue is
v1 data and the loader owns it — but it also erases every catalogue decision v2 has made since,
and migration 0024 is exactly that: the twelve laser hair removal body areas, the retirement of
the four size brackets, and the category grouping.

Skip this and production ends up with v1's four sizes active, no body areas, and every category
null. Migrations run once, so 0024 will never repair it. **Nothing fails.** The booking form
simply offers Small/Medium/Large again.

Verify:

```bash
MELANITE_ENV_FILE=.env.migration npm run etl:catalogue -- --check
```

Expect `Catalogue is already correct.`

### 3.3 Reconcile

```bash
MELANITE_ENV_FILE=.env.migration npm run etl:verify
MELANITE_ENV_FILE=.env.migration npm run etl:verify:providers
MELANITE_ENV_FILE=.env.migration npm run db:verify
```

`etl:verify` reconciles the loaded ledger against Stripe — the authority on what money actually
moved. `etl:verify:providers` checks the people. `db:verify` re-runs the schema gate now that
there is data in it.

Then look with your own eyes: provider count, client count, and the ledger total against what
Xano's `/admin/revenue` reports. A number that matches is worth more than three green checks.

---

## 4. Stripe

### 4.1 The live webhook

Confirm the live webhook endpoint points at **v2**, not the Webflow site.

This has been wrong once. `melanitesuite.com/api/webhooks/stripe` returned 405 from Cloudflare,
which meant every live payment event would have been accepted by Stripe and delivered nowhere.
It fails silently from the app's side — the money arrives, the ledger never hears about it.

Send a test event from the Stripe dashboard and confirm a row lands in `webhook_events`.

### 4.2 Connect accounts

```bash
MELANITE_ENV_FILE=.env.migration npx tsx --tsconfig scripts/tsconfig.json scripts/verify-stripe-onboarding.ts
```

Production keeps the **live** Connect account ids from the v1 export. That is correct here and
wrong everywhere else — see step 6.3.

---

## 5. Point the app at it

### Environment variables apply at BUILD time

Setting a variable in Vercel and pressing **Redeploy** rebuilds the *old commit* with the new
variables. To get new code *and* new variables you need a **push**. This has caused confusion
before; when in doubt, push an empty commit.

### Smoke test, in this order

1. Sign in as a provider.
2. Open the calendar — confirm real appointments are there.
3. Open Earnings — confirm the split figures match Xano.
4. Create a booking, send the payment link, open it as a client. **Do not pay it.**
5. Confirm the Cherry option appears on a service over $200 and not on one under.
6. Cancel the test booking.

---

## 6. After

### 6.1 Leave Xano running

**Do not turn v1 off on cutover night.** Neon's Free plan keeps a **6-hour** restore window.
That is not a safety net for a migration run at 11pm and inspected the next morning.

Xano, kept live and read-only, is the only complete copy of the truth that exists independently
of v2. Keep it for **at least two weeks**. Turning it off is a decision made from "we have not
needed it in two weeks", not from hope.

Before turning it off: take a final export and store it somewhere that is not a laptop.

### 6.2 Providers must add their body areas

Laser hair removal is now twelve named areas rather than four size brackets. Prices cannot be
carried across — a size bracket does not map onto one area. Every provider sees their old
services marked *"retired by Melanite"* on **My Services** and must add the areas they actually
perform, with their own prices.

Tell them before cutover, not after. Until they do, they cannot book hair removal.

### 6.3 The nightly prod → dev copy-down

Whatever mechanism moves the data, the job **must** end with these two steps or it manufactures
a bug every night:

```bash
npm run db:scrub                                                    # dev only
npx tsx --tsconfig scripts/tsconfig.json scripts/dev-connect-accounts.ts
npm run etl:catalogue                                               # if the copy replaced services
```

**`db:scrub`** replaces real client names, emails, phones and notes with synthetic ones. Dev is
publicly reachable at `appdev.melanitesuite.com`, the e2e suite runs against it, `EMAIL_REDIRECT_TO`
points at a real inbox, and agents have full access. It deliberately leaves ids and money alone,
so foreign keys still resolve and the ledger still reconciles. It refuses to run outside dev.

**`dev-connect-accounts.ts`** replaces the imported **live** Connect account ids with test-mode
ones. Without it, dev's checkout tries to pay live accounts with a test key and every payment
fails with "Could not start the payment". This is not hypothetical — it cost most of a morning
already.

Both are `--check`-able. Have the job fail loudly rather than leave dev half-scrubbed.

---

## Rollback

Up to and including step 3, rollback is free: production has nothing to lose, and v1 is still
live and serving clients. Truncate and start again.

After step 5, rollback means pointing the hostnames back at Webflow/Wized and continuing on
Xano. That is the entire reason for step 6.1, and it stops being available the moment Xano is
switched off — which is why that is the last step, not part of the cutover.

Money taken through v2 between cutover and rollback would exist only in Stripe and v2. Reconcile
it by hand from Stripe before restarting; the admin **Tools** page has entry forms for exactly
this.
