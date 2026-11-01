# 07 — Remittance, posting and reconciliation

## Sources

| Source | Mode | Trigger |
| --- | --- | --- |
| Stedi 835 webhook | B | `transaction processed` event → fetch ERA via Stedi API → `remit.ingest` |
| PM read (`pullRemittances`) | A, C | Sync schedule |
| File upload (835 or PM export) | Any | Biller uploads in Remittances (R-01, R-02) |

Raw payloads are stored encrypted (`raw_ref`) before parsing. Ingestion is idempotent on (payer, trace number, payment amount, payment date); duplicate retransmissions are recorded and ignored.

## Parsing

Canonical structure per 835: BPR/TRN (payment), N1 (payer/payee), CLP (claim), CAS (adjustments), NM1 (patient), MOA/MIA (remarks), SVC (lines), DTM (dates), LQ (line remarks), PLB (provider-level adjustments). Stedi returns JSON; the `x12` package parses raw files into the same structure. Golden-file tests cover: paid in full, partial with PR deductible, denied with CO-197, multiple claims per check, reversal and correction pair (CLP02 = 22 then a new CLP), secondary payer crossover, PLB interest and recoupment, zero-pay remittance.

## Matching

Claim level, in order:
1. CLP01 = the claim's `patient_control_number` for this client (assigned by Cleanpost, or read from the PM in Mode A; see `claims.pcn_source`) → match.
2. Payer claim control number already linked to a claim → match.
3. Patient (name + DOB) + DOS + total charge + payer → candidate; one candidate = match with `matched_by: heuristic` (flag for review if the client setting requires); several = `ambiguous`.
4. Otherwise `unmatched` → work item.

Each matched claim records how it matched in `remit_claims.matched_by` (`pcn`, `payer_claim_number`, `heuristic`, `manual`).

Line level: line control number (REF*6R) → exact. Otherwise code + modifiers + units + charge, in order. Unmatched lines → work item.

## Balancing checks

Two checks with fixed names, used the same way in the UI (W-18, R-06, R-04):

1. **835 balance** — runs right after parsing, before matching, posting or verification.
   - Per claim: `charge − paid − Σ adjustments = 0` (CAS amounts, all groups).
   - Per remittance: `Σ claim paid − Σ PLB = BPR payment amount`.
   - Failure → remittance `out_of_balance` and an `out_of_balance` work item with the difference ("835 does not balance"). Nothing is posted or verified until it passes, or an admin accepts the difference with a reason; then only the claims that balance on their own continue.
2. **Posting match** — runs after the PM (Modes A, C) or Cleanpost (Mode B) posts.
   - Per line: paid amount, each adjustment (mapped to the PM's code) and patient responsibility equal the 835.
   - Differences → `posting_exception` work items ("PM posting does not match"); the remittance is `posting_mismatch` until they are resolved, then `reconciled`.

## Adjustment mapping

`adjustment_mappings` translate (group code, CARC) into the PM's adjustment code and an action:
- `CO-45` (charge exceeds fee schedule) → contractual write-off.
- `PR-1`, `PR-2`, `PR-3` (deductible, coinsurance, copay) → transfer to patient responsibility.
- `CO-*` denials (e.g. CO-197 auth, CO-16 missing info, CO-29 timely filing) → no write-off; leave balance open and create a denial work item.
- `OA-23` (prior payer adjudication) → transfer to secondary when a secondary coverage exists.
- Unmapped pairs → posting of that claim is held and a mapping work item is created; once an admin maps it, posting resumes.

Each tenant gets defaults per PM type; clients can override.

## Posting

Mode B: build a `PostingInstruction` per remittance and call `postPayment`. Partial failures are retried per allocation; after 3 failures the remainder becomes a manual posting task with a worksheet listing, per claim and line: patient account, DOS, code, paid, each adjustment with the PM code, patient responsibility, and whether to bill secondary.

Modes A and C: do not post. Read `pullPostings` and compare with the parsed 835 per line. Differences (missing posting, wrong amount, wrong adjustment code, denial written off) become `posting_exception` work items. Optional per client: "Cleanpost corrects PM postings" (uses `postPayment` adjustments) once the adapter supports it.

## Secondary claims

When a primary remit leaves a balance and a secondary coverage exists, build a secondary claim version (837 with prior payer paid amounts and adjustments, loop 2320/2430) and scrub it. Mode A: release in the PM (most PMs create secondaries; Cleanpost verifies). Modes B/C: submit via Stedi.

## Reconciliation

- Remittance is `reconciled` when posted totals equal the 835 per claim and per remittance.
- Phase 2: deposit matching against bank data (trace number and amount) for "payment received but no 835" and "835 received but no deposit" exceptions.
