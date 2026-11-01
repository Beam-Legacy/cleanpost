# 04 — Submission modes A, B and C

Mode is set per client (`clients.default_mode`) with optional per-payer override (`client_payer_settings.mode_override`). Everything before release (pull, eligibility, build, scrub, review) is identical across modes. The modes differ in how claims leave, how remits arrive, and who posts.

**Build order:** Mode A is built first and runs the pilot. Modes B and C are built after the pilot (M7), unless the Tebra test picks Mode C for the pilot (`docs/17-decisions.md` DEC-01, DEC-02).

## Shared front half (all modes)

1. `sync.pull` brings new patients, coverage, encounters and charges into the canonical model.
2. Changed coverage triggers `eligibility.check` (Stedi 270/271). Inactive coverage creates a work item and holds the claim.
3. When an encounter's charges are complete (PM marks it ready, or no changes for a configurable quiet period, default 2 hours), `claim.build` creates claim version 1.
4. `claim.scrub` runs rules and AI review and sets confidence.
5. At or above threshold → `ready` (auto). Below → `needs_review` work item. Blocking finding → `blocked` work item.

## Mode A — PM-native

Use when the PM has a working clearinghouse connection and the adapter can hold or release charges, or at least read claims and remits.

```
PM charge ──pull──► Cleanpost scrub ──(fix)──► pushChargeCorrection ──► releaseCharge ──► PM sends via its clearinghouse
PM clearinghouse ──999/277CA/835──► PM ──pullClaimsAndStatus / pullRemittances──► Cleanpost tracking + review
PM auto-posts ERA ──pullPostings──► Cleanpost verifies posted amounts vs 835 ──mismatch──► exception work item
```

Details:
- Prefer `holdCharge` on pull so nothing goes out unscrubbed. If the PM cannot hold, Cleanpost scrubs after the fact and flags problems before the PM's next batch (setting: PM batch time per client).
- Corrections are written back to the PM with `pushChargeCorrection`, never only in Cleanpost, so the PM stays the system of record.
- Remits are read from the PM (or uploaded as 835 files when the PM cannot provide them, as with Tebra). Cleanpost does not post in Mode A; it verifies the PM's auto-posting and creates exceptions for unposted lines, wrong adjustments and denials. If the PM does not auto-post a remittance (or the practice posts by hand), Cleanpost creates a manual posting task with a worksheet (M-01, F-02) instead of an exception.
- Requires: `pullCharges`, `pullClaimsAndStatus`, `pullRemittances`, `pushChargeCorrection`; `holdCharge`/`releaseCharge` preferred. Any of these may run at level 0 or 3 (manual task or file upload).
- Tebra: hold and release map to its encounter review (an encounter waits in Review until Cleanpost approves it); corrections are manual tasks; 835s come by file upload. See `docs/05-adapters.md`.

## Mode B — Platform submits and receives

Use when the billing company wants full control or the PM's clearinghouse is poor. Requires ERA enrollment with Stedi per payer (one ERA clearinghouse per payer per provider).

```
Cleanpost ready claim ──Stedi professional/institutional claims API──► payer
Stedi webhook ──999, 277CA──► claim.ack
Daily sweep ──276──► Stedi ──277──► claim tracking
Stedi webhook ──835──► remit.ingest ──► match ──► postPayment (adapter) ──► verify ──► reconcile
```

Details:
- On release, mark the charge in the PM as billed externally (`markChargeBilled`) so the PM does not also send it. If the adapter cannot, the onboarding checklist requires the billing company to disable the PM's electronic claim submission for that client.
- ERA enrollment status tracked per client-payer. Until a payer's ERA enrollment is active, that payer runs as Mode C.
- Posting uses `postPayment` with allocations per line, adjustments mapped through `adjustment_mappings`, and patient responsibility. Falls back to a manual posting task.

## Mode C — Hybrid (Stedi submits, PM keeps remits)

Use when claims should go out through Cleanpost but ERA enrollment should stay where it is (common during transition to B, or when the PM's auto-posting works well).

```
Cleanpost ready claim ──Stedi──► payer (999/277CA via Stedi webhooks)
Payer 835 ──► PM's existing clearinghouse ──► PM auto-posts
Cleanpost ──pullRemittances / pullPostings──► verify and work exceptions (same as Mode A back half)
```

Details:
- Same `markChargeBilled` requirement as Mode B.
- Matching uses the patient control number Cleanpost assigned, which the payer returns in CLP01 regardless of which clearinghouse receives the 835.

## Choosing a mode (shown in onboarding, see O-03 and O-07 in `ui/clients.html`)

| Question | If yes |
| --- | --- |
| Does the client's PM submit claims reliably today? | Start in A |
| Can the adapter hold or release charges in this PM? | A is fully supported; otherwise A with after-the-fact scrubbing or C |
| Is the billing company willing to re-enroll ERAs per payer? | B available |
| Is the PM's ERA auto-posting accurate? | Keep remits with the PM (A or C) |

Mode changes are effective for claims released after the change. In-flight claims finish in the mode they were released in (`claims.mode` is fixed at release).

## Capability requirements per mode

| Adapter operation | A | B | C |
| --- | --- | --- | --- |
| pullPatientsAndCoverage | required | required | required |
| pullCharges | required | required | required |
| holdCharge / releaseCharge | preferred | — | — |
| pushChargeCorrection | required | preferred | preferred |
| markChargeBilled | — | required (or PM submission disabled) | required (or disabled) |
| pullClaimsAndStatus | required | optional | optional |
| pullRemittances | required | — | required |
| pullPostings | required | — | required |
| postPayment | — | required (manual fallback allowed) | — |

The onboarding wizard computes which modes are available from the adapter's declared capabilities.
