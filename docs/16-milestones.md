# 16 — Milestones and acceptance criteria

Each milestone ends with a demo on synthetic data. Do not start the next milestone until the acceptance criteria pass in CI. Week estimates assume James building with Claude Code and Julia writing rules and reviewing flows. View IDs (W-01, C-08, ...) refer to the designs in `ui/`.

**Build order: Mode A first.** Everything up to the pilot is built for Mode A (the PM submits, Cleanpost scrubs, releases and verifies). Modes B and C keep their seams in the adapter contract, data model and state machines, but their submission and posting paths are built after the pilot (M7). The Tebra test (below) decides whether the pilot runs in Mode A or Mode C. See `docs/17-decisions.md`.

## Parallel track: Tebra test

Runs whenever test access arrives (ask for it now; see `docs/15-integrations-reference.md`). Not a milestone gate, but it must finish before M6 starts.
- Read-only probe against a test practice that holds synthetic patients only: `GetPractices`, `GetPatients`, `GetCharges` (including unapproved encounters), `GetEncounterDetails`, `GetPayments`, `GetTransactions`.
- Confirm: the practice's encounters pass through Review; `UpdateEncounterStatus` moves Review → Approved; what `GetTransactions` returns for adjustments (codes or amounts only); whether billers can download raw 835 files from Tebra; what Tebra uses as the claim's patient control number.
- Record fixtures for the Tebra adapter's `map.ts` tests.
Output: a confirmed Tebra capability table in `docs/05-adapters.md`, the pilot mode decision (A or C) in `docs/17-decisions.md`, and recorded fixtures.

## M0 — Foundation (weeks 1–2)

Build: monorepo, CI (lint, typecheck, test, axe), Postgres with migrations and RLS, better-auth with MFA, roles and client scope, audit module, logger with redaction, app shell and states (G-01, G-02, G-03 skeleton, G-05, G-08, G-09, G-10, G-11, G-20 to G-25), sign-in and account (A-01 to A-09), auth emails (E-01 invite, E-02 password reset, E-03 new sign-in alert) through a local mail catcher, design tokens and base components in Storybook. Preview deploy to Railway (synthetic data only).
Accept:
- Cross-tenant read test fails as expected (blocked) for every table
- Log scanner finds no synthetic names in a full test run
- Every base component passes axe in both themes

## M1 — Data model, mock PM, integration hub (weeks 3–5)

Build: full schema from `02-data-model.md`; `apps/pm-mock` (including a Tebra profile: encounter Draft/Review/Approved/Rejected workflow, no ERA access, payment totals only, per-account rate limits); adapter contract, registry, `mock`, `manual` and `file` adapters; stub adapters with READMEs; Tebra adapter skeleton generated from the public WSDL (types and `map.ts` drafts, no live calls); `sync.pull` with per-adapter sync policy; synthetic data generator and `pnpm seed`; I-01, I-02, I-03 Integrations; CL-01 Clients list.
Accept:
- `pnpm test:adapters` passes for mock, manual, file and all stubs
- Seeded data appears in canonical tables with correct external refs; re-running a pull creates no duplicates
- Fault injection (auth expiry, 500s, partial pages, rate limits) leads to correct connection states and work items
- Two clients sharing one PM account share its rate limit

## M2 — Claims out, Mode A (weeks 6–8)

Build: claim builder, rules DSL and engine, seed rules (structural, NCCI, starter specialty and payer rules), AI review via `@cleanpost/ai` with redaction, confidence scoring, claim state machine, Mode A release via adapter (hold, correction, release), Stedi sandbox client for eligibility (270/271) and the `eligibility.check` job feeding scrub step 2, `apps/payer-sim` fed by pm-mock's clearinghouse (277CA back into pm-mock, read by sync), work queue (W-01, W-03 to W-12, W-23, G-06), claims (C-01 to C-05, C-08, C-10 to C-13, C-16, C-17), reveal control (G-12).
Accept:
- Scrub catches ≥ 95% of seeded defects with ≤ 5% false blocks
- Claim review resolvable by keyboard in under 20 seconds (measured in Playwright)
- Mode A release produces the right side effects: pm-mock encounter approved, pm-mock sends it to payer-sim, the 277CA result arrives through sync; a correction on a PM without write access creates exactly one manual task
- Eligibility check against the Stedi sandbox stores a 271 summary and feeds scrub step 2
- Every edit produces a correction row

## M3 — Payments in, Mode A verification (weeks 9–11)

Build: 835 parsing from X12 files, golden tests, ingestion and idempotency (PM read and file upload), matching, the two balancing checks, adjustment mappings with PM-type defaults, verification against PM postings, posting exceptions, manual tasks and worksheets (M-01 to M-03, F-02), secondary claim verification (the PM builds secondaries in Mode A), remittances (R-01, R-02, R-04 to R-08), queue panels (W-17 to W-21), C-07.
Accept:
- All golden files parse and balance
- `pnpm test:cycle` passes for Mode A clients (see `12-testing.md`)
- Every unverified or mismatched line has exactly one open work item

## M4 — Denials, eligibility, documents, reports (weeks 12–15)

Build: denial triage and categories, corrected-claim flow (D-01 to D-03, W-16, C-09, C-14); claim status checks via Stedi 276/277 (C-15, W-15); eligibility screens and patients (P-01 to P-06, W-13); card upload and extraction with review (W-14); reports with PDF/CSV export (RP-01 to RP-07, F-01); usage metering; notifications and digest (G-04, S-09, E-04, E-05); timely-filing watch (W-22).
Accept:
- Flow 5 (denial to corrected claim) passes end to end
- Card extraction ≥ 95% field accuracy on the synthetic card set
- Report figures match direct SQL computations in tests

## M5 — Onboarding, settings, hardening (weeks 16–18)

Build: onboarding wizard with capability-driven mode recommendation and go-live checklist (O-01 to O-11, E-06); client overview and settings (CL-02 to CL-09, CL-11); settings (S-01 to S-08, S-10, S-12 to S-14, F-03); operator console (OP-01 to OP-04); I-04, I-05; help, banners and first-week checklist (G-07, G-13, G-14); team view (W-02); session and export controls; runbooks (incident, backup restore); production infrastructure on AWS under BAA.
Accept:
- Flows 1 and 6 pass end to end
- Restore-from-backup drill completed
- Every item in `11-security-hipaa.md` "Before PHI" is checked

## M6 — Tebra adapter and pilot (weeks 19–24)

Build: the Tebra adapter against the test practice (contract tests, recorded fixtures), the 835 upload routine for Tebra clients, pilot with one client in "Review everything", then threshold tuning. If the Tebra test chose Mode C, M6 also builds Stedi claim submission, 999 and 277CA webhooks and `markChargeBilled` handling (estimate: 2–3 more weeks).
Accept (pilot metrics):
- First-pass acceptance ≥ 95%
- ERA lines verified without touch ≥ 90%
- Charge-to-submission median < 24h
- Biller minutes per claim down ≥ 50% vs baseline

## M7 — Modes B and C (after the pilot)

Build: Stedi claim submission (professional and institutional), 999, 277CA and 835 webhooks, payer-sim delivery to the Stedi webhook, Mode B posting via adapter (R-03, R-09), ERA enrollment tracking (CL-10), secondary claims as 837 with prior payer loops, invoicing through a billing provider (S-11 invoices, E-07).
Accept:
- `pnpm test:cycle` passes with clients in Modes A, B and C
- Flows 3, 4 and 7 pass end to end

## Off the pilot path: marketing website

`apps/website`, a static site built from the WEB- designs with the same tokens. Built when there is time; it never blocks a milestone. WEB-11 and WEB-12 are later. WEB-13 (status) is a hosted status page, not part of the static site.

## Explicitly later

AI coding from notes, appeal drafting (D-04), patient statements, client portal (CP-01, CP-02), credentialing, prior auth, voice agents, bank deposit reconciliation, underpayment detection against fee schedules (W-24), what's new (G-15).
