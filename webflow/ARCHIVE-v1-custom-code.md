# Archive: melanitesuite.com custom code as it stood before 2026-08-14

The Webflow header and footer custom code, verbatim, immediately before being replaced by
`site-header.html` and `site-footer.html`. Webflow keeps no version history for these fields, so
this file is the only record that this code ever existed.

Kept because it is the most complete surviving description of how v1's front end actually
behaved — the Xano calls, the role gating, the sidebar wiring — none of which is documented
anywhere else. If something on the marketing site regresses after the cleanup, restore from here.

## Why all of it went

Every removed block targeted `/app/*` or `/pay/*`. Per `docs/webflow-redirects.csv`, Webflow
forwards `/app/(.*)` and `/pay/(.*)` to `app.melanitesuite.com`, so **those URLs have not rendered
a Webflow page since the cutover**. The code was unreachable, not merely redundant.

| Block | Removed because |
| --- | --- |
| Wized embeds (2 scripts) | v1's front-end runtime. `embed.wized.com` was already returning 404. |
| `@keyframes m-spin` | v1 portal spinner. |
| Tip selector / receipt row / topbar CSS | `/pay/*`, redirected away. v2 owns client checkout. |
| `.ln-wrap` login CSS | v1 login at `/app/login`. |
| Contrast + focus-state CSS | v1 portal classes (`db-`, `bk-`, `er-`, `svc-`, `ln-`, `c-`). v2 did its own accessibility work against its own tokens — see `docs/decisions.md`. |
| `.chart-area` / `.bar-inner` | v1 admin chart. v2 fixed its own chart separately (commit `bd5ea6d`). |
| Entire footer | Every block gated on `/app`, `/app/book` or `/app/login`. |

Two things kept: the Webflow badge hide, and the Google gtag tag.

**Worth noting for the record:** `__melGetMe()` read the `jwt` cookie and called Xano
(`x8ki-letl-twmt.n7.xano.io/api:Sl7NOAlp/me`) on every page load, with retry backoff, including on
public marketing pages. That was live authenticated traffic to the system being decommissioned.

---

## Header code (verbatim)

```html
<style>
  .w-webflow-badge{
  display:none !important;
  }
 </style>

 <script async src="https://embed.wized.com/dr1kRU38CXKY7DqKCNbg.js"></script>
<script async type="module" data-wized-id="dr1kRU38CXKY7DqKCNbg" src="https://embed.wized.com/v2/index.js"></script>

<style>@keyframes m-spin { to { transform: rotate(360deg); } }</style>

<style>
/* ============================================================
   FIX 1 — Tip selector: 5-across is too tight on phones.
   Buttons render ~41px wide at 390px (below the 44px tap-target
   minimum) and the "%" labels nearly overflow at 320-360px.
   Re-flow to a 3-column grid (None/10/15 + 20/Custom) so each
   button is a comfortable ~100px tap target and "$ Custom" fits
   on one line. Selected (gold) state is preserved.
   Appears on: /pay/start
   ============================================================ */
@media (max-width: 478px) {
  .c-tip-grid { grid-template-columns: repeat(3, 1fr) !important; }
  .c-tip-btn  { min-height: 56px; padding: 10px 6px !important; }
}

/* ============================================================
   FIX 2 — Receipt rows misalign when a value wraps.
   .c-status-detail-row uses align-items:center, so when a long
   value (e.g. "Laser Hair Removal — Full Legs", the date+time)
   wraps to two lines the left label floats to the vertical
   middle and looks broken. Top-align the label and right-align
   the wrapped value so it reads as an intentional two-line value.
   Appears on: /pay/confirmation, /pay/already-paid
   ============================================================ */
@media (max-width: 767px) {
  .c-status-detail-row   { align-items: flex-start !important; gap: 16px; }
  .c-status-detail-label { flex: 0 0 auto; }
  .c-status-detail-value { text-align: right !important; }
}

/* ============================================================
   FIX 3 — Topbar trust line wraps on phones (optional polish).
   At 390px "Secure Checkout · Powered by Stripe" wraps to two
   lines. Trim the horizontal padding and nudge the font down a
   hair so it sits on a single line.
   Appears on: all /pay/* pages
   ============================================================ */
@media (max-width: 478px) {
  .c-topbar       { padding-left: 20px !important; padding-right: 20px !important; }
  .c-topbar-trust { font-size: 10.5px; }
}
</style>

<style>
@media (max-width: 767px) {
  .ln-wrap        { flex-direction: column !important; }
  .ln-wrap > *    { width: 100% !important; max-width: 100% !important; flex: 0 0 auto !important; }

  /* Optional: hide the marketing panel on phones for a leaner login.
     Uncomment if you'd rather show only the form on mobile.          */
  /* .ln-right    { display: none !important; } */
}
</style>

<style>
/* ============================================================
   1) Muted secondary text -> readable (~5-6:1). #9a9a9a on the
      dark cards/fields. Grouped by page.
   ============================================================ */

/* Dashboard */
.db-topbar-sub, .db-stat-label, .db-action-label, .db-m-per { color: #9a9a9a !important; }

/* Book */
.bk-spct, .bk-subnote, .bksb-role, .bk-splitlbl, .bk-slbl,
.bk-dow, .bk-li, .bk-fl { color: #9a9a9a !important; }

/* Account */
.form-hint, .db-provider-role, .form-label, .qs-label, .notif-sub,
.sec-sub, .acc-help-body, .d-sub, .stripe-key { color: #9a9a9a !important; }

/* Earnings */
.er-sb-prole, .er-statlbl, .er-statsub, .er-ssess, .er-topp,
.er-sb-sec, .app-logout-link { color: #9a9a9a !important; }

/* Services */
.svc-form-hint, .svc-meta-dim, .provider-role-text, .svc-pkg-toggle-sub,
.svc-coming-soon-desc, .svc-stat-label, .svc-stat-sub, .svc-meta-item { color: #9a9a9a !important; }

/* Login */
.ln-subtext, .ln-flabel, .ln-ortext, .ln-fi-desc, .ln-sdesc,
.ln-rb, .ln-footer, .ln-flink { color: #9a9a9a !important; }

/* Client checkout (/pay/*) */
.c-page-subtitle, .c-form-label, .c-payment-sub, .c-service-meta,
.c-summary-section-label, .c-summary-banner-title, .c-when-pill-label,
.c-stripe-note, .c-public-footer,
.c-status-detail-label, .c-status-footer-note { color: #9a9a9a !important; }

/* ============================================================
   2) Dim typed-text input fix. The Account ".form-input" class
      measured ~2.3:1 typed text. Scoped to that class (and the
      dark portal/login/checkout containers) so it does NOT touch
      inputs on the light-background public template pages.
   ============================================================ */
.form-input,
.page-wrapper input, .page-wrapper textarea, .page-wrapper select,
.ln-wrap input, .ln-wrap textarea,
.c-page-public input, .c-page-public textarea { color: #e8e8e8 !important; }

.form-input::placeholder,
.page-wrapper input::placeholder, .page-wrapper textarea::placeholder,
.ln-wrap input::placeholder,
.c-page-public input::placeholder { color: #6a6a6a !important; }

/* ============================================================
   3) Focus states — gold border + soft ring on fields, and a
      visible keyboard-focus outline on interactive controls.
      (Webflow strips the default outline, so keyboard users had
      no focus indicator.)
   ============================================================ */
input:focus, textarea:focus, select:focus {
  border-color: #B8965A !important;
  box-shadow: 0 0 0 3px rgba(184, 150, 90, 0.15) !important;
  outline: none;
}

a:focus-visible, button:focus-visible,
[class*="btn"]:focus-visible, [class*="bksb-item"]:focus-visible,
.bk-cell:focus-visible, .bk-calbtn:focus-visible,
.mnav-burger:focus-visible {
  outline: 2px solid #B8965A !important;
  outline-offset: 2px;
  border-radius: 4px;
}
</style>

<style>
/* ============================================================
   ADMIN — Platform Revenue chart height + single-point fix.
   Bars collapsed to a 3px flat line because .chart-col wasn't
   stretching to fill the 120px .chart-area, so .bar-outer (flex:1)
   had no height and every bar fell back to its 3px min-height.
   align-items:stretch lets the columns fill the height so bars
   grow proportionally; max-width caps each bar so a single month
   reads as one neat centered bar instead of a full-width block
   (multi-month bars stay evenly distributed).
   Appears on: /app/admin
   ============================================================ */
.chart-area { align-items: stretch !important; }
.bar-inner  { max-width: 64px !important; }
</style>

<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-DP91MV4CKT"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());

  gtag('config', 'G-DP91MV4CKT');
</script>
```

---

## Footer code (verbatim)

```html
<!-- ============================================================================
     Melanite — SITE-WIDE FOOTER  ·  FULL replacement (FET-15 Phase 3)
     Built from Ethan's live footer 2026-07-13. Replace the ENTIRE Site Settings
     -> Custom Code -> Footer Code with this file, then Save + Publish.

     Only three things changed vs. the live version:
       1. NEW small <script> defining window.__melGetMe() — a shared, memoized,
          429-resilient /me (Xano Free plan bursts on load). Inserted right after
          the password-eye script.
       2. Sidebar identity block: role-based label (Platform Owner / Developer /
          Medical Director / Licensed Provider, is_admin fallback) AND it now uses
          __melGetMe(), so a 429 retries instead of silently showing "Jane Doe".
       3. Nav wiring: the "Dashboard" item routes admin-view roles
          (owner/developer/MD/legacy is_admin) to /app/admin instead of the
          provider dashboard (BUG-06 fix). The .adm-sidebar selector and every
          other nav item are unchanged.
     FET-05 (2026-07-15): one MAP entry added — 'Daily Room Rental' ->
          /app/room-rental (sidebar items added on every /app page the same day).
     BUG-15 (2026-07-15): NEW role-gate block right after the nav wiring —
          admin-view roles (owner/developer/MD/legacy is_admin) see only
          Dashboard + Account in the provider sidebars; the provider-only items
          (Book Laser Time, Appointments, Earnings, Daily Room Rental,
          My Services, Membership) are hidden once __melGetMe() resolves.
          Real providers: no-op. Decided with Ethan 2026-07-15.
     Everything else (password eye, calendar v1, login Enter-submit, drawer CSS,
     drawer init, calendar v2) is byte-for-byte your current footer.
     ============================================================================ -->

<script>
(function () {
  var st = document.createElement('style');
  st.textContent = '[data-pw-toggle]{cursor:pointer}';
  document.head.appendChild(st);
  // give the login password eye a pointer cursor (it shares .ln-ficon with the email icon)
  function styleLoginEye() {
    var pw = document.querySelector('input.ln-pw');
    if (pw && pw.parentElement) {
      var eye = pw.parentElement.querySelector('.ln-ficon');
      if (eye) eye.style.cursor = 'pointer';
    }
  }
  if (document.readyState !== 'loading') styleLoginEye();
  else document.addEventListener('DOMContentLoaded', styleLoginEye);
  // delegated show/hide toggle
  document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('[data-pw-toggle], .ln-ficon');
    if (!t) return;
    var wrap = t.parentElement;
    if (!wrap) return;
    // for the login icon (.ln-ficon), only act on the password field, not the email icon
    if (!t.hasAttribute('data-pw-toggle') && !wrap.querySelector('input.ln-pw')) return;
    var input = wrap.querySelector('input');
    if (!input) return;
    e.preventDefault();
    var reveal = input.type !== 'text';
    input.type = reveal ? 'text' : 'password';
    t.classList.toggle('is-revealed', reveal);
  });
})();
</script>

<!-- FET-15 NEW: shared, memoized, 429-resilient /me. One fetch per page; any
     portal script can await window.__melGetMe() -> Promise<provider|null>. -->
<script>
window.__melGetMe = window.__melGetMe || (function () {
  var XANO = "https://x8ki-letl-twmt.n7.xano.io/api:Sl7NOAlp";
  var promise = null;
  function jwt() { var m = document.cookie.match(/(?:^|;)\s*jwt\s*=\s*([^;]+)/); return m ? m[1] : ""; }
  return function () {
    if (promise) return promise;
    promise = new Promise(function (resolve) {
      (function attempt(n) {
        var t = jwt();
        if (!t) { if (n < 6) return setTimeout(function () { attempt(n + 1); }, 400); return resolve(null); }
        fetch(XANO + "/me", { headers: { Authorization: "Bearer " + t }, cache: "no-store" })
          .then(function (r) {
            if (!r.ok) {
              if ((r.status === 429 || r.status >= 500) && n < 6) { setTimeout(function () { attempt(n + 1); }, 1500 * (n + 1)); return "retry"; }
              return null;
            }
            return r.json();
          })
          .then(function (d) { if (d === "retry") return; resolve(d && d.provider ? d.provider : null); })
          .catch(function () { if (n < 6) setTimeout(function () { attempt(n + 1); }, 1500 * (n + 1)); else resolve(null); });
      })(0);
    });
    return promise;
  };
})();
</script>

<!-- FET-15 UPDATED: sidebar name/avatar/role. Role label from provider.role
     (is_admin fallback); uses the shared __melGetMe() so 429s retry. -->
<script>
(function () {
  try {
    var nameSel = '.db-provider-name,.admin-name,.appt-prov-name,.er-sb-pname,.bksb-name';
    var avSel   = '.db-avatar,.admin-avatar,.appt-prov-avatar,.er-sb-av,.bksb-avatar';
    var roleSel = '.db-provider-role,.admin-role,.provider-role-text,.appt-prov-role,.er-sb-prole,.bksb-role';
    if (!document.querySelector(nameSel)) return; // not a portal page with the card

    var ROLE_LABELS = {
      platform_owner:   'Platform Owner',
      developer:        'Developer',
      medical_director: 'Medical Director',
      real_provider:    'Licensed Provider',
      test_provider:    'Licensed Provider'
    };

    window.__melGetMe().then(function (p) {
      if (!p) return;
      var first = p.first_name || '', last = p.last_name || '', cred = p.credentials || '';
      var full = (first + ' ' + last).trim();
      if (!full) return;
      var nameText = full + (cred ? ', ' + cred : '');
      var ini = ((first.charAt(0) || '') + (last.charAt(0) || '')).toUpperCase() || (full.charAt(0) || '?').toUpperCase();
      var roleText = ROLE_LABELS[p.role] || (p.is_admin ? 'Platform Owner' : 'Licensed Provider');
      document.querySelectorAll(nameSel).forEach(function (el) { el.textContent = nameText; });
      document.querySelectorAll(avSel).forEach(function (el) { el.textContent = ini; });
      document.querySelectorAll(roleSel).forEach(function (el) { el.textContent = roleText; });
    });
  } catch (e) {}
})();
</script>

<script>
(function () {
  if (location.pathname.indexOf('/app/book') !== 0) return;
  var MON = {January:0,February:1,March:2,April:3,May:4,June:5,July:6,
             August:7,September:8,October:9,November:10,December:11};

  function fixCalendar() {
    var t = document.querySelector('.bk-calm');
    if (!t) return;
    var p = t.textContent.trim().split(/\s+/);
    var mo = MON[p[0]], yr = parseInt(p[1], 10);
    if (mo === undefined || !yr) return;

    var cells = document.querySelectorAll('.bk-cell');
    if (!cells.length) return;

    // 1) weekday offset — clear any stale offset, then place day 1 in its true column
    var firstDow = new Date(yr, mo, 1).getDay(); // 0=Sun .. 6=Sat (header is Sun-first)
    for (var i = 0; i < cells.length; i++) {
      if (cells[i].style.gridColumnStart) cells[i].style.gridColumnStart = '';
    }
    cells[0].style.gridColumnStart = String(firstDow + 1);

    // 2) grey + disable whole past days
    var today = new Date(); today.setHours(0, 0, 0, 0);
    cells.forEach(function (c) {
      var d = parseInt(c.textContent.trim(), 10);
      if (!d) return;
      var cd = new Date(yr, mo, d);
      if (cd < today) {
        c.style.opacity = '0.3';
        c.style.pointerEvents = 'none';
        c.style.cursor = 'default';
        c.setAttribute('data-past', '1');
      } else if (c.getAttribute('data-past')) {
        c.style.opacity = '';
        c.style.pointerEvents = '';
        c.style.cursor = '';
        c.removeAttribute('data-past');
      }
    });
  }

  var root = document.querySelector('.bk-card') || document.body;
  // observer watches childList/characterData only (not attributes), so our style writes don't loop
  new MutationObserver(fixCalendar).observe(root, { childList: true, subtree: true, characterData: true });
  fixCalendar();
  var n = 0, iv = setInterval(function () { fixCalendar(); if (++n > 20) clearInterval(iv); }, 300);
})();
</script>

<script>
(function () {
  if (location.pathname.indexOf('/app/login') !== 0) return;
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var t = e.target;
    if (!t || !t.matches) return;
    if (t.matches('[wized="input_email"]') || t.matches('[wized="input_password"]')) {
      e.preventDefault();
      var btn = document.querySelector('[wized="submit_login"]');
      if (btn) btn.click();
    }
  }, true);
})();
</script>

<style>
@media (max-width: 767px) {
  /* ---- layout: drop the side-by-side, reserve space for the top bar ---- */
  .page-wrapper { display: block !important; padding-top: 52px !important; }
  .admin-layout { display: block !important; }

  /* ---- sidebar -> off-canvas drawer ---- */
  .bksb, .db-sidebar, .er-sb, .appt-sidebar, .adm-sidebar {
    position: fixed !important; top: 0; left: 0; bottom: 0; height: 100% !important;
    width: 280px !important; max-width: 85vw !important; z-index: 9999;
    overflow-y: auto; -webkit-overflow-scrolling: touch;
    background: #0d0d0d; padding-top: 56px !important;
    transform: translateX(-100%); transition: transform .25s ease;
  }
  body.mnav-open .bksb, body.mnav-open .db-sidebar, body.mnav-open .er-sb,
  body.mnav-open .appt-sidebar, body.mnav-open .adm-sidebar { transform: translateX(0) !important; }

  /* ---- main content full width ---- */
  .bk-main, .db-main, .er-main, .adm-main { width: 100% !important; max-width: 100% !important; }

  /* ---- per-page internals ---- */
  .bk-two-col { grid-template-columns: 1fr !important; }           /* Book: stack form + summary */
  .bk-summary { width: 100% !important; max-width: 100% !important; }
  .provider-table { display: block; max-width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; } /* Admin: scroll wide table */

  /* ---- top bar ---- */
  .mnav-bar { position: fixed; top: 0; left: 0; right: 0; height: 52px; z-index: 10000;
    display: flex; align-items: center; gap: 12px; padding: 0 14px;
    background: #0d0d0d; border-bottom: 1px solid rgba(255,255,255,.08); }
  .mnav-burger { width: 40px; height: 40px; flex: 0 0 auto; display: flex; align-items: center;
    justify-content: center; background: transparent; border: 0; cursor: pointer; padding: 0; }
  .mnav-burger span { display: block; position: relative; width: 22px; height: 2px; background: #B8965A; }
  .mnav-burger span::before, .mnav-burger span::after { content: ""; position: absolute; left: 0;
    width: 22px; height: 2px; background: #B8965A; }
  .mnav-burger span::before { top: -7px; } .mnav-burger span::after { top: 7px; }
  .mnav-brand { font-size: 15px; letter-spacing: .14em; color: #fff; font-weight: 600; }
  .mnav-brand small { color: #B8965A; letter-spacing: .22em; font-size: 11px; }

  /* ---- backdrop ---- */
  .mnav-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.55); z-index: 9998;
    opacity: 0; pointer-events: none; transition: opacity .25s; }
  body.mnav-open .mnav-backdrop { opacity: 1; pointer-events: auto; }
}

/* ---- phone polish: stack cramped sections so nothing clips ---- */
@media (max-width: 767px) {
  .db-topbar      { flex-direction: column !important; align-items: flex-start !important; gap: 14px !important; } /* Dashboard: greeting + "Book Laser Time" button stack */
  .db-stats-grid  { grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)) !important; } /* Dashboard KPI cards: 1 col on phones, 2-3 when wider */
  .db-grid-3      { grid-template-columns: 1fr !important; }                                  /* Dashboard: appointments + side column stack (also widens appt rows) */
  .bk-gate-banner { flex-direction: column !important; align-items: flex-start !important; gap: 12px !important; } /* Book: "Set up coverage" drops under the text */

  /* Title + action headers / alerts / page topbars: action drops under the title.
     (Deliberately NOT applied to data rows like quick-stat, svc-pkg-row,
     pagination av2-pag, the calendar header bk-calh, or booking summary rows —
     those should stay side-by-side.) */
  .db-card-header, .er-cardh, .svc-panel-header, .card-header,
  .av2-alert, .er-topbar, .adm-topbar {
    flex-direction: column !important; align-items: flex-start !important; gap: 10px !important;
  }
}
@media (max-width: 478px) {
  .bk-card        { padding: 16px !important; }
  /* Book: roomier calendar cells (~40px) + step content */
}

@media (min-width: 768px) { .mnav-bar, .mnav-backdrop { display: none !important; } }
</style>

<script>
(function () {
  // only the authenticated portal, and not the login page (it has its own fix)
  if (location.pathname.indexOf('/app') !== 0) return;
  if (location.pathname.indexOf('/app/login') === 0) return;

  function init() {
    if (!document.querySelector('.page-wrapper')) return;
    // not a portal page yet
    if (document.querySelector('.mnav-bar')) return;         // already built

    var bar = document.createElement('div');
    bar.className = 'mnav-bar';
    var btn = document.createElement('button');
    btn.className = 'mnav-burger';
    btn.setAttribute('aria-label', 'Open menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = '<span></span>';
    var brand = document.createElement('div');
    brand.className = 'mnav-brand';
    brand.innerHTML = 'MELANITE <small>LASER SUITE</small>';
    bar.appendChild(btn); bar.appendChild(brand);

    var bd = document.createElement('div');
    bd.className = 'mnav-backdrop';

    document.body.appendChild(bar);
    document.body.appendChild(bd);

    function close() { document.body.classList.remove('mnav-open'); btn.setAttribute('aria-expanded', 'false'); }
    btn.addEventListener('click', function () {
      var open = document.body.classList.toggle('mnav-open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    bd.addEventListener('click', close);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });

    // tapping a nav link closes the drawer
    var sb = document.querySelector('.bksb, .db-sidebar, .er-sb, .appt-sidebar, .adm-sidebar');
    if (sb) sb.addEventListener('click', function (e) {
      if (e.target.closest('a, [class*="item"]')) setTimeout(close, 80);
    });
  }

  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);
  // Wized can rebuild parts of the DOM after load — retry a couple times
  setTimeout(init, 800);
  setTimeout(init, 2000);
})();

/* ===== Sidebar navigation wiring =====
   The portal's sidebar items are bare <div>s with no href/handler, so they
   didn't navigate (on desktop or mobile). This wires each one to its page by
   matching its label. Works across all sidebar variants. Verified live.
   FET-15 (BUG-06 fix): the "Dashboard" item now routes admin-view roles
   (owner/developer/MD/legacy is_admin) to /app/admin. dashTarget is read at
   CLICK time (via the shared __melGetMe), so nav works immediately and just
   re-points once role resolves; falls back to /app/dashboard when role is
   unknown — safe for real providers.
   FET-05 (2026-07-15): 'Daily Room Rental' entry added. */
(function () {
  if (location.pathname.indexOf('/app') !== 0) return;

  var dashTarget = '/app/dashboard';
  window.__melGetMe().then(function (p) {
    if (p && (p.role === 'platform_owner' || p.role === 'developer' || p.role === 'medical_director' || p.is_admin === true)) {
      dashTarget = '/app/admin';
    }
  });

  var MAP = [
    ['Book Laser Time', '/app/book'],
    ['Dashboard',       function () { return dashTarget; }],
    ['Appointments',    '/app/appointments'],
    ['Earnings',        '/app/earnings'],
    ['Daily Room Rental', '/app/room-rental'],
    ['My Services',     '/app/services'],
    ['Membership',      '/app/membership'],
    ['Account',         '/app/account']
  ];
  function wire() {
    var sb = document.querySelector('.bksb, .db-sidebar, .er-sb, .appt-sidebar, .adm-sidebar');
    if (!sb) return;
    var items = sb.querySelectorAll('[class*="item"]');
    if (!items.length) items = sb.querySelectorAll('div');
    items.forEach(function (el) {
      if (el.__navWired) return;
      var full = (el.textContent || '').trim();
      var t = full.replace(/[^A-Za-z ]/g, ' ').replace(/\s+/g, ' ').trim();
      for (var i = 0; i < MAP.length; i++) {
        var label = MAP[i][0], url = MAP[i][1];
        if ((t === label || t.indexOf(label) === 0) && full.length <= label.length + 12) {
          el.__navWired = true;
          el.style.cursor = 'pointer';
          (function (u) { el.addEventListener('click', function () { window.location.href = (typeof u === 'function' ? u() : u); }); })(url);
          break;
        }
      }
    });
  }
  if (document.readyState !== 'loading') wire(); else document.addEventListener('DOMContentLoaded', wire);
  setTimeout(wire, 1000);
  setTimeout(wire, 2500);
})();

/* ===== BUG-15: role-gate the provider sidebar items =====
   The per-page sidebars are static markup, so admin-view roles
   (platform_owner / developer / medical_director / legacy is_admin) saw the
   full provider nav on provider pages like /app/account. Once the shared
   __melGetMe() resolves to an admin-view role, hide the provider-only items —
   Book Laser Time, Appointments, Earnings, Daily Room Rental, My Services,
   Membership — leaving Dashboard + Account. Uses the same label-matching as
   the nav wiring above. A section header (*-sec div) is hidden too when every
   nav item that follows it (up to the next header) got hidden. Real providers
   and null /me: no-op, sidebar untouched. Retries mirror wire() since the
   sidebars are static (no Wized rebuild). Decided with Ethan 2026-07-15:
   admins keep Dashboard + Account only. */
(function () {
  if (location.pathname.indexOf('/app') !== 0) return;

  var HIDE = ['Book Laser Time', 'Appointments', 'Earnings',
              'Daily Room Rental', 'My Services', 'Membership'];
  var KEEP = ['Dashboard', 'Account'];

  function labelMatch(el, label) {
    var full = (el.textContent || '').trim();
    var t = full.replace(/[^A-Za-z ]/g, ' ').replace(/\s+/g, ' ').trim();
    return (t === label || t.indexOf(label) === 0) && full.length <= label.length + 12;
  }
  function isNavItem(el) {
    var all = HIDE.concat(KEEP);
    for (var i = 0; i < all.length; i++) if (labelMatch(el, all[i])) return true;
    return false;
  }

  function gate() {
    var sb = document.querySelector('.bksb, .db-sidebar, .er-sb, .appt-sidebar, .adm-sidebar');
    if (!sb) return;
    var items = sb.querySelectorAll('[class*="item"]');
    if (!items.length) items = sb.querySelectorAll('div');
    items.forEach(function (el) {
      for (var i = 0; i < HIDE.length; i++) {
        if (labelMatch(el, HIDE[i])) { el.style.display = 'none'; break; }
      }
    });
    // section headers: hide when every nav item after them (until the next
    // header) is hidden — e.g. if "Provider Portal"/"Settings" empties out
    sb.querySelectorAll('[class*="-sec"]').forEach(function (h) {
      var n = h.nextElementSibling, seen = 0, hidden = 0;
      while (n && String(n.className || '').indexOf('-sec') === -1) {
        if (isNavItem(n)) { seen++; if (n.style.display === 'none') hidden++; }
        n = n.nextElementSibling;
      }
      if (seen && seen === hidden) h.style.display = 'none';
    });
  }

  window.__melGetMe().then(function (p) {
    if (!p) return;
    if (!(p.role === 'platform_owner' || p.role === 'developer' || p.role === 'medical_director' || p.is_admin === true)) return;
    gate();
    setTimeout(gate, 1000);
    setTimeout(gate, 2500);
  });
})();

/* ===== Booking calendar: month navigation + month-aware layout =====
   The "‹/›" arrows are wired to Wized events that don't change the month, and
   the page's fixCalendar() computes the column-offset and past-day greying from
   TODAY instead of the displayed month — so the calendar was stuck on the
   current month and mis-rendered any other month. This:
     - makes the arrows change cal_month and re-run the availability request
       (floored at the current month, capped 12 months ahead), and
     - after each render, sets the correct first-day column offset and greys
       only true past days (none in a future month).
   Verified live: June -> July -> Aug -> back, correct offset + selectable days. */
(function () {
  if (location.pathname.indexOf('/app/book') !== 0) return;
  function ym(dt) { return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0'); }
  function addMonths(s, delta) { var p = s.split('-'); return ym(new Date(+p[0], +p[1] - 1 + delta, 1)); }
  var thisMonth = ym(new Date());

  function fixLayout() {
    var W = window.Wized; if (!W || !W.data) return;
    var cm = W.data.v.cal_month; if (!cm) return;
    var p = cm.split('-'), y = +p[0], m = +p[1];
    var firstDow = new Date(y, m - 1, 1).getDay();           // 0=Sun .. 6=Sat
    var grid = document.querySelector('.bk-calgrid'); if (!grid) return;
    var cells = [].slice.call(grid.querySelectorAll('.bk-cell')); if (!cells.length) return;
    cells.forEach(function (c) { c.style.gridColumnStart = ''; });
    cells[0].style.gridColumnStart = String(firstDow + 1);   // CSS columns are 1-based (col 1 = Sun)
    var now = new Date(), ty = now.getFullYear(), tm = now.getMonth() + 1, td = now.getDate();
    cells.forEach(function (c) {
      var day = parseInt(c.textContent, 10), past = false;
      if (y < ty || (y === ty && m < tm)) past = true;
      else if (y === ty && m === tm && day < td) past = true;
      if (past) { c.setAttribute('data-past', '1'); c.style.opacity = '0.3'; c.style.pointerEvents = 'none'; }
      else { c.removeAttribute('data-past'); c.style.opacity = ''; c.style.pointerEvents = ''; }
    });
  }
  function runFix() { [50, 250, 500].forEach(function (ms) { setTimeout(fixLayout, ms); }); }

  document.addEventListener('click', function (e) {
    var b = e.target.closest('.bk-calbtn'); if (!b) return;
    var t = b.textContent || '';
    var delta = /›|>/.test(t) ? 1 : (/‹|</.test(t) ? -1 : 0); if (!delta) return;
    e.stopPropagation();
    var W = window.Wized; if (!W || !W.data) return;
    var cur = W.data.v.cal_month || thisMonth;
    var tgt = addMonths(cur, delta);
    if (delta < 0 && tgt < thisMonth) return;                 // don't go before the current month
    if (delta > 0 && tgt > addMonths(thisMonth, 12)) return;  // cap 12 months ahead
    W.data.v.cal_month = tgt;
    var ex = W.requests && W.requests.execute && W.requests.execute('availability');
    if (ex && ex.then) ex.then(runFix); else runFix();
  }, true);

  // initial render + re-render safety (Wized rebuilds the cells per fetch)
  var tries = 0, iv = setInterval(function () {
    var grid = document.querySelector('.bk-calgrid');
    if (grid) {
      clearInterval(iv);
      runFix();
      var t, mo = new MutationObserver(function () { clearTimeout(t); t = setTimeout(fixLayout, 40); });
      mo.observe(grid, { childList: true });
    } else if (++tries > 40) clearInterval(iv);
  }, 250);
})();
</script>
```
