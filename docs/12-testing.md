# 12 — Testing and synthetic data

The full cycle must run end to end on synthetic data before any real connector exists. Nothing in this repo ever contains real PHI.

## Synthetic data (`packages/testing/synth`)

`generatePractice()` is deterministic for a seed (its own PRNG, no Faker or Synthea yet).

- **Patients**: drawn from the synthetic identity pools (`synth/identifiers.ts`), so the log scanner can detect leaks. Dates of birth stay within 1930–2015, the range the scanner recognises; pediatric patients are therefore 11–17.
- **Coverage**: Medicare for patients 65 and over, about 20% Medicaid otherwise, commercial for the rest. Exactly 8% have secondary coverage. The answer key marks 10% inactive (the PM does not know) and 3% with the wrong payer on file.
- **Encounters and charges**: one generator per specialty profile (`synth/profiles.ts`): code mix, modifiers, diagnoses and charge amounts in integer cents, codes only. Profiles now: family medicine, pediatrics, orthopedics; the pilot specialty Julia picks gets its own. Deliberate defects come at exact rates: missing modifier 5%, NCCI conflict 2% (real procedure-to-procedure pairs), invalid pointer 1%, duplicate 0.5%. Arthroscopies without prior authorization are also marked. The answer key, stored in `pm_mock.answer_key` and never served by the API, says which record carries which defect, so scrub accuracy can be measured.
- **Tenants**: "Northwind Billing" with the clients from the `ui/` synthetic world (`ui/CONVENTIONS.md`), backed by pm-mock with the matching PM profile:
  - Lakeside and Willamette: Tebra profile, one shared Tebra account;
  - Cascade: managed API profile, for AdvancedMD;
  - Riverbend: manual adapter.

  Until Modes B and C are built (M7), every Northwind client runs in Mode A. "Harbor RCM" (1 client, manual adapter) is used for isolation tests.

`pnpm seed` loads these into Cleanpost and, when `PM_MOCK_DATABASE_URL` and `PM_MOCK_SECRET` are set, into pm-mock (Lakeside 180 patients and 320 encounters, Cascade 150 and 260, Willamette 140 and 240). The first sync then brings them into Cleanpost.

## Payer simulator (`apps/payer-sim`)

Accepts claims (from pm-mock in Mode A; Stedi-shaped JSON from Cleanpost in Modes B/C once M7 is built). Behaviour per payer profile:
- 277CA within 1–30 minutes (simulated clock); rejects structural errors (configurable list).
- Adjudicates after a simulated 7–20 days: paid in full, contractual write-off (CO-45), patient responsibility (PR-1/2/3), denials with realistic CARC/RARC by defect type (missing modifier → CO-4, no auth → CO-197, inactive coverage → CO-27, duplicate → CO-18, timely → CO-29).
- Batches adjudicated claims into 835s per payment with PLB interest occasionally, and sometimes a reversal and correction pair.
- Delivers 835s to Cleanpost's Stedi webhook endpoint (Mode B) or to pm-mock's clearinghouse inbox (Modes A/C).
- Time control endpoint (`POST /clock/advance?days=14`) so tests can run a 30-day cycle in seconds.

Stedi's own sandbox is used to verify request shapes and 277CA handling; it does not return test 835s, which is why the simulator exists.

Built so far (M2): claim intake (`POST /claims`), the 277CA front-end edits (subscriber not found A7:33, invalid rendering NPI A7:562, billing NPI A7:85, missing diagnosis A7:254, bad pointer A7:255, total mismatch A7:178; otherwise A2:20), acknowledgments 1 to 30 simulated minutes after receipt (`GET /acks`), and the clock (`POST /clock/advance`). pm-mock's clearinghouse (`apps/pm-mock/src/clearinghouse.ts`) sends queued claims every minute (or `POST /admin/api/clearinghouse/run`) and writes the 277CA onto the PM's claim, where sync reads it. The payer's view of each member comes from the generator's answer key: inactive coverage is accepted here and denied at adjudication; coverage that belongs to another payer is "subscriber not found".

Built in M3: adjudication 7 to 20 simulated days after acceptance (`src/adjudicate.ts`, payer profiles in `src/payers.ts`): allowed amount as a percent of charges per payer and code, CO-45 for the rest, copay PR-3 on office visits, deductible PR-1 and coinsurance PR-2 from the member file (which the payer draws down), none on commercial preventive care or Medicaid; denials CO-27 (coverage not active), CO-31 (member unknown), CO-29 (past the payer's filing limit), CO-18 (exact duplicate), CO-4 (office visit with a procedure and no modifier 25), CO-97 (NCCI bundle, from `rules/seed/reference.json`), CO-197 (no prior auth on the payer's list); and, as real payers do, about 2.5% of lines on a first submission denied for reasons no scrub can see (CO-16 missing information, CO-50 not medically necessary, CO-22 another payer is primary, CO-96 not covered), chosen by claim and line, never on a corrected claim. Payment runs (`src/payments.ts`, on `GET /remits` or `POST /payments/run`) batch decisions into one 835 per submitter, payer and payee with `packages/x12` `write835`, with PLB L6 interest when a commercial payer pays 18 or more days after receipt; a replacement (frequency 7) carries the reversal of the earlier payment. pm-mock reads the 835s after the last control number into its ERA inbox and auto-posts them (`src/era.ts`): one payment per 835, one posting per line in the PM's codes, denials left open, and on purpose about 1.5% of lines skipped, 1.5% with the wrong adjustment code and a third of denied lines written off, so the posting match has real differences to find. PMs with no hold (the managed_api profile) bill their ready encounters at 6 pm Pacific, or on `POST /admin/api/clearinghouse/run?bill=1`. The Tebra profile has no ERA API: its 835s are downloaded from the pm-mock admin page and uploaded in R-02. Claim status (M4): `POST /2024-04-01/change/medicalnetwork/claimstatus/v2` answers a 276 in Stedi's JSON shape from what payer-sim received (`src/claim-status.ts`): not found until the 277CA time, A3 for a front-end rejection, P1/20 in process (one claim in ten, by its control number, P3/21 waiting for records), and F1/65 paid or F2/1 denied with the 835's trace number once a payment run decided it. In local and preview, admins see a "Demo clock" bar on Work and Remittances that moves the date forward 1, 7 or 14 days for the payer simulator, the mock PM and Cleanpost together (demo time, `docs/17-decisions.md` DEC-18), runs the clearinghouse with the billing batch, queues a sync for every mock-PM connection and runs the daily follow-up sweep. Demo time is on after `pnpm seed` in local and preview; to go back to today locally, set `offset_ms` to 0 in `app.clock` and `payer_sim.clock`. `pnpm demo:reset` starts the demo world over 90 days back and the worker replays the 90 days through the pipeline with simulated billers (DEC-19); the bar shows the replay's progress. It needs payer-sim, the mock PM with `PM_MOCK_ADMIN_PASSWORD`, and the same password in the worker's environment. For a demo, I-02 of a mock-PM connection also offers Expire the login (demo) and Fix the login (demo): the mock PM refuses or accepts that practice's login (`POST`/`DELETE /admin/api/practices/:id/faults`) and the connection syncs at once, so a failed connection and its notification appear in seconds (`docs/18-demo-script.md`).

## Test layers

| Layer | Tool | Covers |
| --- | --- | --- |
| Unit | Vitest | Domain functions: rules DSL, scrub steps, confidence, matching, balancing, adjustment mapping, state machines, money math |
| Golden files | Vitest | 835/837/277 parsing and serialization against fixtures in `packages/testing/golden` (sources: Stedi docs examples, then de-identified partner files) |
| Integration | Vitest + Postgres (testcontainers) | Jobs, RLS isolation, idempotency, webhook handling |
| Adapter contract | `pnpm test:adapters` | Every adapter |
| End to end | Playwright | Flows 1–7 from `docs/09-ui-screens.md`, run against seed + simulator with the clock advanced |
| AI evals | Custom runner | Labeled claims and denials; accuracy thresholds gate prompt or model changes |
| Accessibility | axe in Storybook and Playwright | Every screen |
| Security | CI checks | Cross-tenant access tests, log PHI scanner, dependency audit |

## Cycle test (the MVP's definition of working)

One command, `pnpm test:cycle`, seeds Northwind Billing, generates 500 encounters, runs the full loop with the simulated clock advanced 45 days, and asserts the list below. Before M7 it covers Mode A clients only (pm-mock generic profile, pm-mock Tebra profile with 835s uploaded as files, and the manual adapter); from M7 it adds one client each in Modes B and C.
- every claim reaches a terminal or expected state;
- scrub catches ≥ 95% of the seeded defects;
- every 835 passes the 835 balance check and every line is verified (A, C) or posted (B), or has exactly one open work item explaining why;
- no PHI appears in logs or job payloads;
- no cross-tenant reads.

Built (M3, Mode A): `apps/worker/cycle/cycle.test.ts`, run by `pnpm test:cycle` and in CI. It seeds Northwind with about 500 encounters across the three mock-PM practices (two on the Tebra profile, one on a PM with no hold), runs the real job queue with pm-mock and payer-sim in process, has a biller approve what is in review, and moves the demo clock (DEC-18: the payer, the PM and Cleanpost together) 45 days in seven steps. At each step the clearinghouse runs (with the no-hold PM's billing batch), Tebra 835s are uploaded as files, every practice syncs and the daily follow-up sweep runs. It then asserts the list above: every claim paid, partly paid or closed, or blocked, rejected or denied with its open item (ready with its manual task when the PM refused the release; submitted or accepted with its follow-up when nothing came back); the scrub catches at least 95% of seeded defects (encounter defects and coverage the payer reports inactive or unknown) with at most 5% false blocks; every 835 balances; every 835 line verified or covered by exactly one open item, and no posting item without a differing line; one item per unmatched payment; no synthetic names, member IDs or birth dates in the logs or job payloads; and nothing of Northwind visible to Harbor RCM. The manual adapter clients join when manual posting tasks are built.
