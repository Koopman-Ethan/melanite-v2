# Retiring v1

What gets turned off, in what order, and the things that must not be turned off at all.

The governing rule: **v1's rollback is Webflow + Wized + Xano together.** Xano alone is a
database nobody can log into. Cancel any one of the three and the rollback stops existing, so
all three go at the end of the same window, not one at a time.

---

## Done — 2026-08-01

- **Stripe: the three v1 webhook destinations disabled.** `Platform`, `Connected Accounts` and
  `Daily Room Events`, all pointing at Xano. Disabled rather than deleted, so they can be
  re-enabled if v1 has to come back inside the rollback window.

  This was the urgent one. While they were active every live payment was processed twice —
  Xano writing its own rows and sending its own emails, so a client paying would get two
  receipts, one from a system being retired.

  v1's spec names a fourth endpoint, `/webhooks/stripe/package`. It is not in the live list, so
  it was either removed earlier or only ever existed in sandbox.

- **`App Prod` is the only active destination**, on
  `https://app.melanitesuite.com/api/webhooks/stripe`, 10 events, 0% error rate.

---

## The redirects

`docs/webflow-redirects.csv`, for Site settings → Publishing → 301 redirects.

### Old payment links still work

This is the part worth getting right. v1 built its links as `APP_BASE_URL + "/pay/" + token`,
which is the same path shape v2 uses, **and the ETL preserved every token**. So a client with a
payment link in a text message from last week can still pay — the redirect carries the token
across and v2 resolves it against the same row.

Without the redirect those links 404, which reads to a client as the business having
disappeared. With it, they simply work.

The same applies to `/pay/package/`. It is listed FIRST in the CSV deliberately: redirects match
in order, and `/pay/(.*)` would otherwise swallow the package links and send them to the wrong
page.

### Marketing pages that stay

Not in the CSV, and must not be redirected:

`/` · `/about` · `/contact` · `/laser-training` · `/laser-rental` · `/refund-policy` ·
`/payment-plans`

`/laser-training` stays as a marketing page by decision — it carries SEO and ad traffic. Point
its signup button at `https://app.melanitesuite.com/training`; do not redirect the page itself.

### Two things to check before importing

**The wildcard syntax.** The CSV uses `(.*)` in the old path and `%1` in the target. Confirm
against Webflow's current behaviour by importing, then visiting one real payment link and
checking it lands on the right token. If Webflow wants a bare `*` instead, it is a
find-and-replace on two lines. Getting this wrong is silent — the redirect simply does not fire.

**The header row.** `Old Path,New Path` is the common format. If the import is rejected, open
Webflow's own export or its import dialog to see the header names it expects and rename the two
columns; the data underneath does not change.

### The one imperfect redirect

`/training-balance` goes to `https://app.melanitesuite.com/training`, which is the course
signup page rather than a balance page. v2 pays a balance at `/pay/training/{enrollmentId}`,
which needs an id nobody has in a bookmark, so there is no honest generic target. A student who
lands there sees courses rather than their balance; Keoni resends the real link from
**Admin → Training**. Worth a sentence on that page if it is kept.

### Incomplete by construction

The CSV covers every v1 path that appears in the sitemap or in `docs/v1-spec/`. Webflow may hold
app pages that are in neither — anything excluded from the sitemap and never named in an API
response. Open Webflow's Pages panel and check for anything under `/app/`; the `/app/(.*)`
catch-all at the end of the CSV will carry most of them, but a page whose v2 equivalent has a
different name needs its own line above that catch-all.

---

## At the two-week mark, together

Not before. Each of these individually ends the ability to roll back.

1. Delete the Webflow app pages, keeping the redirects in place
2. Remove the Wized script embed from Webflow's site and page custom code
3. Cancel Wized
4. **Roll the Stripe API key** Xano and Wized were using — a live secret key left active in a
   decommissioned system is the real security exposure here, and it outlives everything else
5. Take a final Xano export somewhere that is not a laptop, then switch Xano off

---

## Never delete, in Stripe

v1 and v2 share **one Stripe account**. Deleting any of these breaks production immediately:

- **Connect accounts** — all five are how providers get paid
- **Products and prices** — the medical director and Growth Hub prices are live in v2's
  membership flow, and `platform_settings` points at them by id
- **Subscriptions** — four active memberships
- **Customers** — v2 references them for card-on-file and for billing
- **Charges, payment intents, refunds, invoices** — financial records, and Stripe will not allow
  it in any case

The only Stripe objects that genuinely retire are the **old webhook destinations** and the
**old API keys**.
