# The nightly dev refresh

Replaces appdev's database with a scrubbed copy of production, every night at 09:40 UTC
(03:40 Denver in summer). `.github/workflows/nightly-dev-refresh.yml` runs it;
`scripts/refresh-dev.ts` is the whole implementation.

Run it by hand with `npm run db:refresh-dev`, or from the Actions tab — the workflow has
`workflow_dispatch` for exactly that.

## Why appdev never serves real client details

This is the part worth understanding, because it is the reason the script is shaped the way it
is.

appdev.melanitesuite.com is publicly reachable and production data is real people: names, email
addresses, phone numbers, treatment notes. The obvious implementation — copy production down,
then scrub it — has a window between those two steps where appdev is serving exactly that. The
window is short on a good night. On a bad one the job dies in the middle and the window stays
open until somebody notices.

So **the load and the scrub are one transaction.** Readers see the previous contents until it
commits and the scrubbed contents afterwards. The real details exist inside the transaction and
are never visible outside it. Any failure at any point rolls the whole thing back and leaves dev
exactly as it was — a stale copy, which is harmless.

That is also why there is no second database, no Neon branch to promote, and no Vercel variable
to swap after the fact. Postgres already gives the guarantee those mechanisms were going to
approximate, and it gives it for free.

## What it needs

Three repository secrets:

| Secret | What |
| --- | --- |
| `DEV_DATABASE_URL` | appdev's database. Written to, destructively. |
| `PROD_DATABASE_URL_READONLY` | production. **Give this a role that cannot write.** |
| `DEV_STRIPE_SECRET_KEY_WRITE` | test-mode key, for the Connect account swap |

The production credential is read-only by intention but not by enforcement. Making the role
genuinely read-only means this workflow *cannot* damage production even if something in it is
wrong, which is worth more than any check in the script.

## The order, and why the last step is outside the transaction

1. **Preflight** — both databases on the same migration, source and target genuinely different,
   and the target's role able to set `session_replication_role`. All three fail fast, before
   anything is dumped.
2. **`pg_dump --data-only`** from production. Data only: the schema belongs to the migrations,
   and restoring production's would make dev's migration history a fiction.
3. **One transaction** — truncate every public table, restore, scrub, commit.
4. **`dev-connect-accounts.ts`** — outside the transaction, because it calls the Stripe API and
   that cannot be rolled back. Production's Connect ids are *live* ones, invisible to a test-mode
   key, so until this runs appdev can take no payments. That is broken, not unsafe, which is why
   it is allowed to be outside.
5. **`db:scrub --check`** — asks the question again from outside the run that just happened, so a
   bug that made step 3's own assertion vacuous still gets caught.

## Two things to confirm on the first real run

Neither could be verified when this was written, and both fail loudly and immediately rather
than halfway through:

- **`session_replication_role`.** The restore needs foreign keys deferred for the session,
  because `pg_dump` does not guarantee that its table order satisfies them and Drizzle does not
  declare constraints `DEFERRABLE`. Neon should permit this for the database owner. If it does
  not, the preflight says so in one line and nothing has been touched.
- **`pg_dump` version.** A client older than the server refuses outright. The workflow pins
  `postgresql-client-18` to match Neon; if production moves to a newer major, that pin moves too.

## When it fails

Dev is left on the previous night's copy. That is the designed outcome, not a partial state —
there is nothing to clean up and nothing to unpick. Fix the cause and re-run from the Actions
tab.

The one failure worth reading carefully is `LOADED BUT NOT SCRUBBED`. It should be impossible:
the scrub commits with the data or not at all. If it ever appears, the guarantee this whole
script exists for has broken, and appdev is serving production data — run `npm run db:scrub`
immediately.
