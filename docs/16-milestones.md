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

Build: monorepo, CI (lint, typecheck, test, axe), Postgres with migrations and RLS, better-auth with MFA, roles and client scope, audit module, logger with redaction, app shell and states (G-01, G-02, G-03 skeleton, G-05, G-08, G-09, G-10, G-11, G-20 to G-25), sign-in and account (A-01 to A-05, A-07 to A-09; A-06 moves to M5 with S-02), auth emails (E-01 invite, E-02 password reset, E-03 new sign-in alert) through a local mail catcher, design tokens and base components in Storybook. Preview deploy to Railway (synthetic data only).
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

Status (Nov 2, 2026): built.
- **Contract tests:** `pnpm test:adapters` covers the mock adapter for each profile against pm-mock, plus the manual, file, stub and Tebra-skeleton adapters.
- **Seeded data and duplicates:** `packages/sync/test/sync.test.ts` checks that seeded data lands with external refs and that a repeat pull creates no duplicates.
- **Faults:** `packages/sync/test/faults.test.ts` covers faults, connection states and work items.
- **Shared rate limit:** two limiter instances share Tebra's limit, and Lakeside and Willamette sync together under the real limits without a 429.
- **Worker:** the worker over a real queue is covered in `apps/worker/test`.
- **UI:** Run now, Pause and Resume on I-02 are in the e2e suite.
- **Moved to later milestones:** claim status, remittance and posting pulls are applied from M2 and M3, with the code that uses them.

## M2 — Claims out, Mode A (weeks 6–8)

Build: claim builder, rules DSL and engine, seed rules (structural, NCCI, starter specialty and payer rules), AI review via `@cleanpost/ai` with redaction, confidence scoring, claim state machine, Mode A release via adapter (hold, correction, release), Stedi sandbox client for eligibility (270/271) and the `eligibility.check` job feeding scrub step 2, `apps/payer-sim` fed by pm-mock's clearinghouse (277CA back into pm-mock, read by sync), work queue (W-01, W-03 to W-12, W-23, G-06), claims (C-01 to C-05, C-08, C-10 to C-13, C-16, C-17), reveal control (G-12).
Accept:
- Scrub catches ≥ 95% of seeded defects with ≤ 5% false blocks
- Claim review resolvable by keyboard in under 20 seconds (measured in Playwright)
- Mode A release produces the right side effects: pm-mock encounter approved, pm-mock sends it to payer-sim, the 277CA result arrives through sync; a correction on a PM without write access creates exactly one manual task
- Eligibility check against the Stedi sandbox stores a 271 summary and feeds scrub step 2
- Every edit produces a correction row

Status (Nov 2, 2026):
- Met: scrub accuracy (100% caught, 0% false blocks on 1,800 synthetic claims); keyboard review under 20 s (`apps/web/e2e/work-queue.spec.ts`); Mode A release approves the encounter in pm-mock and the claim status comes back through sync; one manual task per PM operation that needs a person; a corrections row per changed field (`packages/claims` tests).
- Built: W-01, W-03, W-06, W-07, W-10, W-11, W-12, W-21 and W-23 panels, keyboard J/K/A/E/S/R, Undo (DEC-13); C-01 (saved views, search, filters, pages), C-02 to C-05, C-08 with live findings, C-11 from the claim header.
- Met since: the 277CA comes from payer-sim through pm-mock's clearinghouse and sync (`packages/claims/test/release.test.ts`).
- Built since: eligibility. `packages/eligibility` speaks Stedi's 270/271 JSON; payer-sim answers it from the payers' member files (pm-mock's seed loads them); claims wait for a check before the scrub (`eligibility.check`). Open: the same check against the Stedi sandbox once the key arrives.
- Built since: C-06 with G-12 reveal, C-10, C-13 (before release, DEC-15), C-16.
- Built since: W-04 bulk bar, W-05 assign (with in-app notification), C-17 bulk release (claim reviews whose findings are all info).
- Built since: C-12 hold (claim state `on_hold`).
- Built since: W-08 saved views (personal, or shared with the team by admins).
- Open: W-09 (more filters), G-06 (remapping shortcuts), the C-01 column picker and export; these move to M5 with settings.

## M3 — Payments in, Mode A verification (weeks 9–11)

Build: 835 parsing from X12 files, golden tests, ingestion and idempotency (PM read and file upload), matching, the two balancing checks, adjustment mappings with PM-type defaults, verification against PM postings, posting exceptions, manual tasks and worksheets (M-01 to M-03, F-02), secondary claim verification (the PM builds secondaries in Mode A), remittances (R-01, R-02, R-04 to R-08), queue panels (W-17 to W-21), C-07.
Accept:
- All golden files parse and balance
- `pnpm test:cycle` passes for Mode A clients (see `12-testing.md`)
- Every unverified or mismatched line has exactly one open work item

Status (Nov 2, 2026):
- Built: `packages/x12` 835 parser and writer (canonical structure in `packages/domain/src/remit`), golden files in `packages/testing/golden/835` (paid in full, partial with deductible, CO-197 denial, several claims per check, reversal and correction, secondary crossover, PLB interest and recoupment, zero pay, and one that does not balance); all parse, balance and round-trip.
- Built: ingestion with idempotency, from the PM (`pullRemittances`) and by upload (R-02); matching by control number, payer claim number and line; the 835 balance check; claim moves (paid, partly paid, denied, reversed); `denial`, `remit_unmatched` and `out_of_balance` items.
- Built: the posting match (Modes A and C): `pullPostings` into `pm_postings`, per-line comparison in the PM's adjustment codes with built-in defaults and tenant/client mappings, `posting_exception` per claim or per unposted payment (after 3 grace days), `mapping_needed` per CARC pair; items close themselves when the PM fixes the posting; remittance verifying → reconciled | posting_mismatch.
- Built: payer-sim adjudication and 835s (docs/12-testing.md), the mock PM's ERA inbox with auto-posting (and deliberate posting mistakes), the PM's own billing batch for PMs with no hold, and ERA downloads for the Tebra profile.
- Built: R-01, R-02, R-04; queue panels for denials, posting differences, unmatched and out-of-balance payments and mappings (W-16 to W-20, read and resolve; correction and write-off are M4); the preview-only payer simulator clock on Work and Remittances.
- Built: `pnpm test:cycle` for the mock-PM Mode A clients, passing (acceptance 2 and 3); W-19 map an adjustment code (admins; per PM type or client; closes the items and re-checks); W-17 link an unmatched payment to a candidate claim, or set it aside as before go-live or not this client's; the scrub blocks a member the payer does not know (271 AAA 72/75).
- Built: C-07 claim payments tab; R-06 and W-18 accept a difference (admins, with a reason; claims that balance on their own go on, the rest are set aside), with the `remittance.accept_difference` permission.
- Built: manual posting (M-01, M-02, F-02 as CSV, M-03): where Cleanpost cannot read the PM's postings (manual adapter, stubs), each matched payment opens one posting task with a worksheet in the PM's codes; "Mark as posted" with the PM's payment ID reconciles it on that person's word (lines `confirmed`); "Couldn't complete" records the reason and assigns the task to the owner; the manual tasks page shows open tasks and estimated hand work by operation and PM.
- Built: R-08 code explainer: adjustment and remark code chips explain themselves on hover or focus, in our own words (`explainCode`, no X12 list text, no procedure descriptions).
- Next: the worksheet as PDF (F-02), the manual adapter clients in `pnpm test:cycle` (charges by file), secondary claim verification.

## M4 — Denials, eligibility, documents, reports (weeks 12–15)

Build: denial triage and categories, corrected-claim flow (D-01 to D-03, W-16, C-09, C-14); claim status checks via Stedi 276/277 (C-15, W-15); eligibility screens and patients (P-01 to P-06, W-13); card upload and extraction with review (W-14); reports with PDF/CSV export (RP-01 to RP-07, F-01); usage metering; notifications and digest (G-04, S-09, E-04, E-05); timely-filing watch (W-22).
Accept:
- Flow 5 (denial to corrected claim) passes end to end
- Card extraction ≥ 95% field accuracy on the synthetic card set
- Report figures match direct SQL computations in tests

Status (Nov 2, 2026):
- Built: denial triage (`packages/domain/src/remit/denials.ts`): ten categories, a plain explanation and a rules-based suggestion per denied line (modifier 25 for an office visit denied CO-4 beside a procedure or preventive visit; 59 where the NCCI edit allows it, write-off where it does not; the authorization number for CO-197; check coverage for eligibility; write-off for timely filing and duplicates). Labeled "Suggested"; an LLM may word it later but never sets a code.
- Built: the corrected-claim flow (Flow 5): W-16 Build correction makes a new version with frequency 7 and the payer's claim number (locked, C-09 banner), applies the fix, scrubs it; release in Mode A is a task to resubmit it from the PM; the claim moves on when the PM shows it sent again (the old denial on the PM's record does not count); the denial item closes when the corrected claim is accepted or paid. C-14 write-off (reason, note over $100, billers up to $500, admins above) closes the balance and leaves a task to post the adjustment in the PM. D-01 Denials by category with the open balance at risk.
- Tests: domain advice, the Flow 5 loop and write-off against the mock PM (packages/claims), and Flow 5 end to end in the browser (a CO-4 denial made by `e2e/fixtures/denial.ts` through the app's own code).
- Built: D-02 denial detail (a drawer from a D-01 row): the denied lines with codes explained and the suggestion, at risk, corrected claim by (the client's filing limit for the payer from the denial date), similar denials of the same code from the payer for the client, the history, and Build correction, Write off, Reassign, Open claim. D-03 write-off shared by W-16 and D-02: the client's PM write-off codes, the denied amount by default (never the patient's share on other lines), partial allowed; over the tenant's approval limit a biller requests approval and an admin approves or declines it in the queue (`write_off_approval`, DEC-16); bulk for admins, one client at a time.
- Tests: write-off over the limit, request, approve, decline, cancel when moot, partial with a patient balance left, and bulk (packages/claims); the request state machine and the amount and deadline helpers (domain); D-02, the request and approval across two users, and bulk in the browser.
- Built: claim status checks (276/277, DEC-17). The daily sweep opens a follow-up (W-15) for a claim with no 277CA a week after it was sent or no payment a month after acceptance, and checks open follow-ups weekly; a person checks a claim once a day from C-02 or W-15 (15 seconds, then again in an hour). The answer is a `status_277` claim event in plain words with its codes (C-15), the suggested next step and, where it implies one, a task (send records, resubmit). A submitted claim the payer has becomes accepted; follow-ups close when the payer accepts it or the 835 arrives. payer-sim answers Stedi's claim status path.
- Tests: payer-sim's 277, the client's parsing and errors, the advice per category, and in packages/claims the sweep, the check, the once-a-day limit, the task, and follow-ups closing (also on an 835 in packages/remit); W-15 and C-15 in the browser (`e2e/fixtures/status.ts`).
- Built: P-01 patient detail (from a claim's Open patient): coverage by priority with each one's latest 271 and Check eligibility again (a second check within the hour asks first; each check is billed), DOB and member IDs masked until revealed (G-12, audited), insurance cards, claims with paid amounts and balances, open balance and patient responsibility from the 835s. P-03 eligibility result: status, coverage dates, copay, deductible remaining and coinsurance, "Not returned by payer" where the 271 has none, the patient's other coverages, Check again. Viewing is audited.
- Built (Nov 3): reports (DEC-20). RP-01 overview (collections, first-pass acceptance, denial rate, days in A/R, released without review, ERA lines verified without touch, each against the period before; first-pass by week; released without review by client; every client), RP-02 client report (KPIs, A/R aging, denial reasons, results by payer with small payers rolled up), RP-03 A/R aging (insurance or patient, by payer or client, slow payers flagged, amounts open the claims), RP-04 denials (weekly by category, recovered, written off, open, top codes in plain words), RP-05 team (admins: workload per biller, backlog per client), RP-07 definitions with the report's own numbers, RP-06 CSV exports with the definitions as comment lines, F-01 the practice report for the browser's save as PDF. Exports are audit-logged. Demo time (DEC-18) and 90 days of replayed history (DEC-19) give them three months of data in local and preview.
- Tests: report figures against hand-worked and direct SQL computations on a small known world, scope included (`packages/reports`, the acceptance criterion; it found line adjustments missing from the adjustments total); report helpers and CSV (domain); every report and the CSV export in the browser, with axe in both themes.
- Built (Nov 4, settings for the demo, ahead of M5): the settings shell with its section nav (sections not built yet say so), S-01 users and roles (role, clients, two-factor method, last active, what each role can do) and S-13 audit log (filter by user, action, record type, period and record ID; plain-language actions and details; CSV export, itself recorded). Then invites (DEC-21): S-02 invite one or more addresses with a role and clients, E-01 email, pending and expired invites on S-01 with resend and withdraw, A-06 accept (a new person makes their sign-in, sets up two-factor and joins; someone with an account signs in and joins), every step audited. Tests: invitation and membership state machines; invite, resend, withdraw, expiry, accept and tenant isolation against the database; `?next=` paths; in the browser, invite to join for a new person and for someone with an account, resend and withdraw, axe on S-02 and A-06. Then S-03 edit user (DEC-22): role and clients, reset two-factor, sign out everywhere, deactivate (G-11 confirm; open items back to the queue) and reactivate, each limited to the admin's company and audited; tested against the database (owner, self, other company, sessions in other companies untouched) and in the browser. Then S-08 adjustment mappings: a tab per PM in use, codes waiting for a mapping first, the company's mappings and Cleanpost's defaults, edit in place and add a code; saving checks the waiting lines again; denial codes are refused here and on W-19 (docs/07). Then S-04 automation (DEC-23): the company default threshold with a live simulation of the last 30 days, a confirm when lowering by more than 5, each client on the default, its own number or review everything, with its released-without-review and first-pass rates; audited. Tests: threshold rules and the simulation (domain), the automation figures against a known world (reports), e2e with axe. Then S-05 and S-06 rules (DEC-24): every rule with its 30-day hits and overrides (over 20% flagged), filters and search, the built-in code checks with their hits; the drawer shows the rule in plain words generated from its JSON, tests it on the last 30 days, and switches a built-in rule off for the company (G-11) or one client, or a company rule off, with its history; audited. Tests: the describer and switches (domain), a switched-off rule left out of the scrub for that client only (claims), e2e with axe. Next in settings: S-07 proposed rules and the rule editor, notifications (S-09), branding, usage, security and company profile.
- Built (Nov 4, clients for the demo, ahead of M5): CL-02 client overview (month to date against the onboarding baseline, first pass by week, open items by kind linking into the queue, billers, batch time, threshold, payers), recording the baseline (also used by RP-02 and the practice report), CL-08 pause and resume through the client state machine (releases and PM corrections wait while paused and go out on resume; syncing continues), CL-07 activity; CL-01 rows open the overview and show the month's claims, first pass and release rate. Tests: client state machine and baseline comparisons (domain); a paused client's release refused and handed back on resume (claims); e2e with axe. Next: CL-03 to CL-06, then the onboarding wizard (O-01 to O-11).
- Next in M4: P-02 and P-06 edits (saved in Cleanpost with a task to update the PM; the adapter contract has no patient or coverage write yet), W-13 eligibility issues, card capture (W-14), notifications and digest, timely-filing watch (W-22).

## M5 — Onboarding, settings, hardening (weeks 16–18)

Build: onboarding wizard with capability-driven mode recommendation and go-live checklist (O-01 to O-11, E-06); invites (S-02, A-06); client overview and settings (CL-02 to CL-09, CL-11); settings (S-01 to S-08, S-10 to S-14, F-03; S-11 shows usage only until invoicing in M7); operator console (OP-01 to OP-04); I-04, I-05; help, banners and first-week checklist (G-07, G-13, G-14); team view (W-02); session and export controls; runbooks (incident, backup restore); production infrastructure on AWS under BAA.
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
