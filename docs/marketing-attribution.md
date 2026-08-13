# Exhibit A — Attributed Marketing Revenue: Methodology

Attached to and incorporated into the Consultant Retainer Agreement between Melanite Laser
Suite ("Client") and Koopman Digital ("Consultant").

---

## 1. Purpose

This document defines how **Attributed Marketing Revenue**, as referenced in Sections 1.4.1 and
1.4.2 of the Agreement, is captured, calculated and reported.

Sections 2 through 8 are contractual. Section 9 is an implementation note, included so that the
method can be verified rather than taken on trust; it is descriptive and is not part of the
parties' agreement.

## 2. Definitions

**Tracked Marketing Source** — a marketing channel listed in Section 3, recorded against a
person's first touch by the mechanism described in Section 4.

**Attributed Provider** — a provider whose first recorded touch came through a Tracked Marketing
Source, and whose provider account was created on or after the Implementation Date in Section 7.

**Attributed Marketing Revenue** — the total revenue retained by Melanite, in a given calendar
month, from the platform activity of Attributed Providers, net of the exclusions and adjustments
in Section 6.

## 3. Tracked channels

Marketing links carry UTM parameters in this format:

```
https://melanitesuite.com/?utm_source=[SOURCE]&utm_medium=[MEDIUM]&utm_campaign=[CAMPAIGN]
```

`utm_source` and `utm_medium` take fixed values, so that a channel is always spelled the same
way and cannot fragment across reports:

| Channel | `utm_source` | `utm_medium` |
| --- | --- | --- |
| Google Business Profile | `google_business` | `gbp_post` |
| Instagram | `instagram` | `social` |
| Facebook | `facebook` | `social` |
| Email newsletter | `newsletter` | `email` |
| Paid ads — Google (future) | `google_ads` | `cpc` |
| Paid ads — Meta (future) | `meta_ads` | `cpc` |

`utm_campaign` is freeform and names the specific effort — for example `fall_promo_2026`.

**Organic Google Search** carries no UTM parameters and is recorded automatically from the
referring URL at the moment of first touch. It is a Tracked Marketing Source.

Two further sources are **recorded but are not Tracked Marketing Sources**, and generate no
revenue share. They are recorded so that they can be told apart from a tracking failure:

- `direct` — no referrer and no campaign parameters.
- `provider_referral` — word of mouth from an existing provider, recorded by the Client when the
  invitation is issued.

Additional channels may be added by tagging links at the Consultant's direction, using the same
convention. A channel not listed above and not tagged is not tracked.

## 4. How attribution is captured

Attribution is **first touch**: credit goes to the channel that first brought a person to
Melanite, not to the channel of their most recent visit, and not to the channel of the visit on
which they transacted.

The sequence is:

1. A person clicks a tagged link and arrives at the marketing site, `melanitesuite.com`.
2. The landing URL — including the full raw query string — and the HTTP referrer are recorded at
   that moment, and are not overwritten by any later visit.
3. That record travels with them to the platform, `app.melanitesuite.com`, when they enrol in a
   training course or accept an invitation.
4. When a provider account is created, the stored first touch is attached to it permanently.

**Melanite has no self-service provider signup, by design.** A provider is invited by the Client,
typically after attending a training course. First touch is therefore usually recorded weeks or
months before the provider account exists, and the two are joined when the invitation is
accepted. Attribution is captured at first touch and is not re-derived at signup.

Attribution is captured for **providers only**. Clients booking treatments are not tracked; a
treatment is attributed through the provider who performed it, not through the client who paid
for it.

## 5. Revenue covered

Attributed Marketing Revenue is **the revenue Melanite retains from an Attributed Provider's
activity on the platform**, from every revenue stream, for as long as the Agreement remains in
effect.

This deliberately covers all streams rather than a fixed list, because a fixed list excludes new
revenue types by silence rather than by decision. At the date of this Exhibit the streams are:

| Stream | What Melanite retains |
| --- | --- |
| Course enrolment fees | The entire fee — enrolments are not split with a provider |
| Client treatment payments | Melanite's contractual share of the service amount |
| Treatment payments collected outside the platform (Groupon, cash, cheque, Cherry financing) | Melanite's share, whether received directly or owed by the provider |
| Daily treatment-room rental | The entire amount — rental is not split |
| Medical-director membership and Epicutis subscriptions | The entire amount |
| No-show and late-cancellation fees | Melanite's share of the fee |

Revenue is counted in the calendar month in which the transaction is recorded in the platform
ledger, regardless of when the underlying service is delivered. A deposit and a later balance
payment are counted in their own months.

## 6. What does not count

- **The provider's own portion of client payments.** That is the provider's earnings, not
  Melanite's revenue.
- **Tips, in full.** One hundred percent of every tip is paid to the provider.
- **Revenue from any provider whose provider account was created before the Implementation
  Date** in Section 7. Attribution is never applied retroactively.
- **Revenue from providers whose first touch was untracked or direct** — no identifiable source.
- **Revenue from providers recorded as `provider_referral`.** A referral is recorded, and is
  therefore distinguishable from a tracking failure, but word of mouth from an existing provider
  is not a marketing channel and earns no share. A provider referral is not credited to the
  referring provider's own source.

**Refunds, chargebacks and write-offs are netted** against Attributed Marketing Revenue in the
calendar month in which they occur, including where the original payment fell in an earlier month
and a share has already been paid on it. Where a month nets negative, the amount carries forward
against the next month's share.

A write-off applies where a provider owes Melanite a share of money they collected directly —
most commonly Groupon — and that amount is determined to be uncollectable. Until it is written
off it counts as revenue.

## 7. Implementation date

Attribution tracking under this methodology takes effect on:

**______________________** *(to be completed once tracking is live and verified)*

Only providers whose accounts are created on or after this date can be Attributed Providers. No
provider existing before this date is attributed to any source, whatever their subsequent
activity, and this includes every provider migrated from the previous platform.

## 8. Reporting

Each calendar month the Consultant will provide the Client with a report showing:

- Attributed Marketing Revenue, broken down by source and by campaign;
- the same figures broken down by revenue type;
- **revenue from providers with no tracked source, shown separately**, so that the report's
  totals reconcile against the Client's own revenue reporting;
- refunds, chargebacks and write-offs applied in the period, and any amount carried forward;
- the Consultant's resulting share.

The report is generated from the **platform transaction ledger**, which is the system of record
for all Melanite revenue, and is reconciled against Stripe records where a transaction passed
through Stripe. The ledger is used rather than Stripe alone because a material part of Melanite's
revenue never passes through Stripe at all — Groupon, Cherry financing, cash and cheques among
them — and a Stripe-derived figure would silently omit it.

The report is produced by a function within the **Client's own administrative interface** and may
be run by the Client independently, at any time, for any period. Supporting data may be requested
under Section 1.4.2 of the Agreement, and the Client's ability to generate the report directly is
intended to satisfy that section in the ordinary case.

If either party believes this methodology needs adjustment, it is addressed through the review
process in Section 6.1 of the Agreement.

---

## 9. Implementation note *(descriptive, not contractual)*

Attributed Marketing Revenue corresponds to the sum of the `melanite_cut` column of the platform
ledger (`ledger_entries`), across rows whose provider is an Attributed Provider, within the
reporting month.

That column is used because it already carries the definition this Exhibit describes: tips are
held in a separate column and are excluded from it; provider-paid revenue such as room rental is
recorded unsplit, so Melanite's cut is the whole amount; splits that differ from the standard
arrangement are stored as they actually occurred rather than recomputed from a rate; and refunds
are recorded as their own rows rather than by altering the original.

Stripe metadata (`source`, `campaign`, `provider_id`) is additionally attached to each payment
that passes through Stripe. It exists so the ledger can be reconciled against Stripe and so
channel performance is visible in the Stripe dashboard. It is not the source of the report.
