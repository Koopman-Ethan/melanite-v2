# Webflow custom code

What belongs in each Site Settings → Custom Code field on `melanitesuite.com`, and why. Webflow
keeps no version history for those fields, so this directory is the only record.

| Field | Contents |
| --- | --- |
| **Head Code** | Paste `site-header.html` whole |
| **Footer Code** | **Empty.** Nothing needs to run there. |

Save, then **Publish** — publishing is what makes custom code live, and the Designer preview does
not run it.

## Why the footer is empty

Two things used to be there and both are gone.

**v1's portal code**, until 2026-08-14 — Wized, a Xano `/me` poller that read the `jwt` cookie on
every page load, sidebar wiring, the booking calendar. All of it was gated on `/app/*`, which
`docs/webflow-redirects.csv` forwards to `app.melanitesuite.com`, so none of it had been able to
run since the cutover. Archived verbatim in `ARCHIVE-v1-custom-code.md`.

**First-touch attribution capture**, 2026-08-14 to 2026-08-18. Removed when the consulting
arrangement moved to a flat retainer: it wrote a first-touch record to `localStorage` and appended
it to every link to the app, and the app side that would have read it was never built and no
longer will be. Capture that nothing consumes is worse than none — the next person to find it
assumes something depends on it. Reasoning in `docs/decisions.md`; the tagging convention that
outlived it is in `docs/marketing-attribution.md`.

Analytics now live entirely in GA4 (`G-DP91MV4CKT`, loaded from the header) plus cross-domain
measurement configured in the GA4 admin rather than in code.

This explanation stays in the repo rather than as an HTML comment in the field. A comment there
would ship to every visitor and expose internal paths and history in view-source, for no benefit
to anyone reading the page.

## If you ever add code to either field

Two constraints, both learned by breaking the live site:

1. **No markup-like text anywhere, including inside comments.** A literal script tag in a comment
   opens a real script element mid-document; the rest of the comment is then parsed as JavaScript
   and the whole block dies.
2. **Stay under 10,000 characters per field.** Webflow truncates mid-token past that.

Both failures are silent — the page keeps loading and the code simply never runs.
