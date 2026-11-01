# Cleanpost UI reference: how the files are built

Every area file (`work.html`, `claims.html`, ...) is a static HTML reference. Each design is one `<section class="ref-view" id="<ID>">` with a spec block and a frame. `work.html` is the canonical example; copy its patterns.

## File skeleton

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cleanpost UI · <Area></title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@600;700&family=Public+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="assets/tokens.css">
<link rel="stylesheet" href="assets/components.css">
<link rel="stylesheet" href="assets/reference.css">
</head>
<body>
<header class="ref-top"> ... copy from work.html, set the active nav link ... </header>
<div class="ref-body">
  <div class="ref-intro"><h1>Area name</h1><p>One or two sentences.</p></div>
  ...sections...
</div>
<script src="assets/vendor/lucide.min.js"></script>
<script src="assets/shell.js"></script>
</body>
</html>
```

## One design = one section

```html
<section class="ref-view" id="W-01">
  <div class="ref-meta">
    <div class="ref-title">
      <span class="ref-id">W-01</span>
      <h2>Work queue</h2>
      <div class="row"><span class="tag">Page</span><span class="tag">MVP</span><span class="tag">Route /work</span></div>
    </div>
    <dl class="ref-spec">
      <dt>Purpose</dt><dd>...</dd>
      <dt>Data</dt><dd>...fields and where they come from (table names from docs/02-data-model.md)</dd>
      <dt>Actions</dt><dd>...each control and what it does, incl. keyboard shortcuts</dd>
      <dt>States</dt><dd>...loading, empty, error, permission, edge cases</dd>
      <dt>Rules</dt><dd>...validation, audit logging, PHI handling, confirmations</dd>
    </dl>
  </div>
  <div class="ref-frame"><div class="ref-canvas" style="--w:1440px"> ...the design... </div></div>
</section>
```

- Type tag is one of: Page, Page tab, Panel, Modal, Drawer, Popover, Component, State, Email, PDF, Website.
- Pages: the frame contains `<div class="app" data-nav="claims" data-client="All clients"><main class="main">...</main></div>`. `shell.js` adds the sidebar and top bar. `data-nav` values: work, claims, remits, denials, tasks, clients, reports, integrations, settings, audit. Add `data-role="biller"` to hide admin nav. Operator pages use `data-variant="operator"` and `data-nav="op-tenants" | "op-health" | "op-jobs"`.
- Modals and drawers: `<div class="ref-canvas overlay-stage" style="--w:1200px;--h:720px">` containing a `ghost-page` (a few `ghost-line`/`ghost-block` elements), a `<div class="scrim"></div>`, then either `<div class="center-stage"><div class="modal">...</div></div>` or `<div class="drawer">...</div>`. Size `--h` so nothing is clipped.
- Popovers, toasts and components: `<div class="ref-canvas ref-pad" style="--w:960px">` with the element(s) shown, optionally anchored next to the trigger they open from.
- Side panel variants: `<div class="ref-canvas ref-pad" style="--w:560px">` containing one `.panel`.

## Rules for the designs

- Use only classes in `assets/components.css` and inline `style` for one-off layout (widths, grid columns, gap). Never hard-code a color; use `var(--token)`.
- Icons: `<i data-lucide="name"></i>` (Lucide names, e.g. circle-check, circle-x, triangle-alert, clock, send, sparkles, circle-dashed, inbox, file-text, landmark, plug-zap, building-2, chevron-down, x, plus, filter, upload, download, copy, pencil, trash-2, rotate-ccw, refresh-cw, eye, lock, key-round, mail, calendar, git-compare, external-link, circle-help, info, ellipsis).
- Status chips: `<span class="chip chip-good"><i data-lucide="circle-check"></i>Paid</span>`; chip classes and icons follow the status table in the design system README: outline/circle-dashed (Draft, Closed, Voided), chip-flight/clock (Submitted, Accepted, Built, Reversed), chip-ready/send (Ready), chip-warn/triangle-alert (Needs review, Blocked, Partially paid, Due soon), chip-bad/circle-x (Rejected, Denied, Overdue, Failed, Out of balance), chip-good/circle-check (Paid, Posted, Balanced, Healthy).
- Mode badges: `<span class="mode">Mode A</span>`.
- Codes (CPT, ICD-10, CARC, NPI, trace numbers) use `.code` or `.codechip`. No CPT descriptions.
- AI output always in `.suggestion` with the sparkles icon and the word "Suggested".
- Money: `$1,284.50`, right-aligned in tables (`td.num`). Patient names in lists "Last, F."; full DOB and member ID only in detail views, masked with a reveal control.
- Copy: plain, sentence case, buttons name outcomes. No lorem ipsum, no emoji, no exclamation points. Use the synthetic world below.
- Accessibility: real `<button>`, `<a>`, `<label>`; icon-only buttons get `aria-label`.

## Synthetic world (use consistently)

- Tenant: Northwind Billing. Users: Dana Reyes (biller, DR), Marcus Lee (biller, ML), Priya Shah (admin, PS), Julia Beam (owner, JB).
- Clients: Lakeside Family Medicine (Tebra, Mode A, live), Cascade Pediatrics (AdvancedMD, Mode B, live), Willamette Ortho (Tebra, Mode C, live), Riverbend Counseling (SimplePractice, manual adapter, Mode A, live), Harbor Dermatology (athenaOne, onboarding).
- Payers: Medicare (Noridian JF), Regence BlueCross BlueShield, Oregon Health Plan, UnitedHealthcare, Aetna, Cigna, Moda Health, PacificSource, Providence Health Plan.
- Patient control numbers: `LFM-26-004812`, `WOR-26-001377`, `CPD-26-002210`, `RBC-26-000611`. Trace numbers like `8841203`. NPIs like `1932204417`.
- Dates: around Oct 2026; "today" is Thu, Oct 29, 2026.
