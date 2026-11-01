# 12 — Testing and synthetic data

The full cycle must run end to end on synthetic data before any real connector exists. Nothing in this repo ever contains real PHI.

## Synthetic data (`packages/testing/synth`)

- **Patients**: generated with Synthea (open-source synthetic patient generator) or Faker with a fixed seed. Names drawn from a known synthetic list so the log scanner can detect leaks.
- **Coverage**: mix of commercial, Medicare, Medicaid; 10% inactive; 8% with secondary coverage; 3% with mismatched payer.
- **Encounters and charges**: generator per specialty profile (`profiles/<specialty>.json`) with code mix, modifier frequency, diagnoses and charge amounts. First profile: the pilot specialty Julia picks. Include deliberate defects at known rates (missing modifier 5%, invalid pointer 1%, NCCI conflict 2%, duplicate 0.5%) so scrub accuracy can be measured.
- **Tenants**: "Northwind Billing" with the clients from the `ui/` synthetic world (`ui/CONVENTIONS.md`), each backed by pm-mock with the matching PM profile (Tebra profile for Lakeside and Willamette, generic profile for Cascade, manual adapter for Riverbend). Until Modes B and C are built (M7), every Northwind client runs in Mode A. "Harbor RCM" (1 client, manual adapter) for isolation tests.

`pnpm seed` loads these into Cleanpost and pm-mock.

## Payer simulator (`apps/payer-sim`)

Accepts claims (from pm-mock in Mode A; Stedi-shaped JSON from Cleanpost in Modes B/C once M7 is built). Behaviour per payer profile:
- 277CA within 1–30 minutes (simulated clock); rejects structural errors (configurable list).
- Adjudicates after a simulated 7–20 days: paid in full, contractual write-off (CO-45), patient responsibility (PR-1/2/3), denials with realistic CARC/RARC by defect type (missing modifier → CO-4, no auth → CO-197, inactive coverage → CO-27, duplicate → CO-18, timely → CO-29).
- Batches adjudicated claims into 835s per payment with PLB interest occasionally, and sometimes a reversal and correction pair.
- Delivers 835s to Cleanpost's Stedi webhook endpoint (Mode B) or to pm-mock's clearinghouse inbox (Modes A/C).
- Time control endpoint (`POST /clock/advance?days=14`) so tests can run a 30-day cycle in seconds.

Stedi's own sandbox is used to verify request shapes and 277CA handling; it does not return test 835s, which is why the simulator exists.

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
