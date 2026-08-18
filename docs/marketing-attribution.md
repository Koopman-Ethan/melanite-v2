# Marketing link tagging

How to tag Melanite marketing links so Google Analytics reports read cleanly.

**This is a reference, not a contract.** An earlier version of this file was Exhibit A to a
consulting agreement that paid a share of attributed revenue. That arrangement was dropped on
2026-08-18 in favour of a flat monthly retainer, and with it went per-provider attribution, the
cutoff date, the Stripe metadata, and the reporting obligations. See the attribution entry in
`docs/decisions.md`. What remains is the part that was always independently useful.

## Why tag at all

GA4 groups traffic by source and medium. If the same channel is spelled `instagram` in one post,
`Instagram` in another and `ig` in a third, it becomes three rows in every report and the channel
looks smaller than it is. Fixed values keep it one row.

## Link format

```
https://melanitesuite.com/?utm_source=[SOURCE]&utm_medium=[MEDIUM]&utm_campaign=[CAMPAIGN]
```

Parameters can go on any page, not just the home page — tag whichever page the post is actually
sending people to.

| Channel | `utm_source` | `utm_medium` |
| --- | --- | --- |
| Google Business Profile | `google_business` | `gbp_post` |
| Instagram | `instagram` | `social` |
| Facebook | `facebook` | `social` |
| Email newsletter | `newsletter` | `email` |
| Paid ads — Google (future) | `google_ads` | `cpc` |
| Paid ads — Meta (future) | `meta_ads` | `cpc` |

`utm_campaign` is freeform and names the specific effort — `fall_promo_2026`, `summer_lhr`. Use
lower case with underscores; GA4 treats `Fall_Promo` and `fall_promo` as different campaigns.

## What not to tag

- **Organic search.** Google Search is detected automatically from the referrer. Tagging it would
  overwrite real organic data with whatever you typed.
- **Links between pages of melanitesuite.com.** An internal link with UTM parameters restarts the
  visitor's session in GA4 and credits the new source, which destroys the original attribution.
- **Google Ads**, once running. Auto-tagging handles it with `gclid`; manual UTMs on top can
  conflict.

## Measuring training enrolments

The question worth answering — which channels bring people who actually enrol — spans two
domains: melanitesuite.com is Webflow, `/training` is on app.melanitesuite.com. GA4 treats that
as two separate sessions by default, so an Instagram visitor who enrols shows up as
`melanitesuite.com / referral` rather than as Instagram.

Two settings fix it, both configuration rather than code:

1. **Cross-domain measurement** — Admin → Data Streams → Configure tag settings → Configure your
   domains. Add `melanitesuite.com` and `app.melanitesuite.com`.
2. **A conversion event** on the enrolment confirmation, marked as a key event.

Without step 1, step 2 reports enrolments but attributes them all to the app domain.
