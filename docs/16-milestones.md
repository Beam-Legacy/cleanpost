# 16 — Milestones and acceptance criteria

Each milestone ends with a demo on synthetic data. Do not start the next milestone until the acceptance criteria pass in CI. Week estimates assume James building with Claude Code and Julia writing rules and reviewing flows.

## M0 — Foundation (weeks 1–2)

Build: monorepo, CI (lint, typecheck, test, axe), Postgres with migrations and RLS, better-auth with MFA, roles and client scope, audit module, logger with redaction, app shell (sidebar, top bar, client switcher, command palette skeleton), design tokens and base components in Storybook.
Accept:
- Cross-tenant read test fails as expected (blocked) for every table
- Log scanner finds no synthetic names in a full test run
- Every base component passes axe

## M1 — Data model, mock PM, integration hub (weeks 3–5)

Build: full schema from `02-data-model.md`; `apps/pm-mock`; adapter contract, registry, `mock`, `manual` and `file` adapters; stub adapters with READMEs; `sync.pull`; synthetic data generator and `pnpm seed`; S-16 Integrations; S-08 Clients list.
Accept:
- `pnpm test:adapters` passes for mock, manual, file and all stubs
- Seeded data appears in canonical tables with correct external refs; re-running a pull creates no duplicates
- Fault injection (auth expiry, 500s, partial pages) leads to correct connection states and work items

## M2 — Claims out (weeks 5–9)

Build: claim builder, rules DSL and engine, seed rules (structural, NCCI, starter specialty and payer rules), AI review via `@cleanpost/ai` with redaction, confidence scoring, state machine, Mode A release via adapter, Modes B/C submission via Stedi sandbox client, `apps/payer-sim` (277CA), webhooks, S-02 Work queue (claim review, blocked, rejection), S-03 Claim detail, S-04 Claim editor, S-05 Claims list.
Accept:
- Scrub catches ≥ 95% of seeded defects with ≤ 5% false blocks
- Claim review resolvable by keyboard in under 20 seconds (measured in Playwright)
- Release in each mode produces the right side effects (pm-mock released charge; Stedi sandbox accepted request; payer-sim 277CA applied)
- Every edit produces a correction row

## M3 — Payments in (weeks 9–13)

Build: 835 parsing (Stedi JSON and X12 files), golden tests, ingestion and idempotency, matching, balancing, adjustment mappings with PM-type defaults, posting via adapter (B), verification against PM postings (A, C), manual posting tasks and worksheets, secondary claims, S-10, S-11, S-12.
Accept:
- All golden files parse and balance
- `pnpm test:cycle` passes (see `12-testing.md`)
- Every unposted or mismatched line has exactly one open work item

## M4 — Denials, eligibility, documents, reports (weeks 13–17)

Build: denial triage and categories, corrected-claim flow, S-13; eligibility checks and S-06; card upload and extraction with review; S-14 reports with PDF/CSV export; usage metering; notifications and digest (S-17); timely-filing watch.
Accept:
- Flow 5 (denial to corrected claim) passes end to end
- Card extraction ≥ 95% field accuracy on the synthetic card set
- Report figures match direct SQL computations in tests

## M5 — Onboarding, settings, hardening (weeks 17–20)

Build: S-07 onboarding wizard with capability-driven mode recommendation, go-live checklist, S-09, S-15 (users, rules incl. proposed rules from corrections, mappings, thresholds, branding, usage), S-19 audit log, S-20 operator console, session and export controls, runbooks (incident, backup restore), production infrastructure on AWS under BAA.
Accept:
- Flows 1, 6 and 7 pass end to end
- Restore-from-backup drill completed
- Every item in `11-security-hipaa.md` "Before PHI" is checked

## M6 — First real adapter and pilot (weeks 20–26)

Build: the adapter for the first design partner's PM (likely Tebra), contract tests against its test account, recorded fixtures; pilot with one client in "Review everything", then threshold tuning.
Accept (pilot metrics):
- First-pass acceptance ≥ 95%
- ERA lines posted or verified without touch ≥ 90%
- Charge-to-submission median < 24h
- Biller minutes per claim down ≥ 50% vs baseline

## Explicitly later

AI coding from notes, appeal drafting, patient statements, client portal, credentialing, prior auth, voice agents, bank deposit reconciliation, underpayment detection against fee schedules.
