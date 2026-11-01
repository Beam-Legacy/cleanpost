# 06 — Rules engine, scrubber and AI

## Principle

Deterministic rules decide. The LLM reads, explains, extracts and suggests, always as structured output that deterministic code validates. Every automated decision is explainable to a biller in one sentence and traceable to a rule ID or model output.

## Scrub pipeline (`packages/domain/scrub`)

Runs on every claim version. Steps run in order; each produces findings `{ ruleId, severity: 'block' | 'warn' | 'info', field, message, suggestedFix? }`.

1. **Structural** — required fields for 837P/837I present and well-formed: NPIs (Luhn check with 80840 prefix), tax ID, subscriber, payer ID, dates, at least one diagnosis, pointers valid, POS valid, units > 0, charges > 0.
2. **Eligibility** — coverage active on date of service; payer on claim matches the active coverage; COB order consistent.
3. **Code validity** — ICD-10 valid on the date of service and billable (not a header code); CPT/HCPCS valid; modifiers valid; NDC format when required.
4. **NCCI** — procedure-to-procedure edits with modifier indicators; medically unlikely edits on units.
5. **Payer rules** — rules scoped to the payer (e.g. modifier requirements, prior auth required for listed codes, rendering vs billing NPI requirements, taxonomy required).
6. **Client rules** — rules scoped to the client or client-payer (e.g. always bill under group NPI, specific place-of-service mapping).
7. **History** — duplicate claim check (same patient, DOS, code, payer within lookback); prior denials for the same code-payer pattern.
8. **AI review** — the LLM receives a de-identified claim view (see Redaction) plus the findings so far and returns structured output: additional concerns, a plain-language summary for the biller, and suggested fixes with the evidence for each. AI concerns become `warn` findings only; they can never `block` alone.

## Confidence score

```
start at 100
each block finding    → decision = blocked (score irrelevant)
each warn finding     → minus rule.weight (default 15)
each info finding     → minus 2
first claim for this client-payer pair (no history) → minus 20
payer first-pass acceptance for this client < 90% over 60 days → minus 10
AI concern present    → minus 10
clamp 0..100
```

`decision = auto_release` if no block findings and score ≥ effective threshold (client-payer override, else client default; default 90). Otherwise `review`. Weights are config, tuned in the pilot from correction data.

## Rule definition

Rules are data (`rules` table), not code, so they can be scoped and promoted. Condition and action use a small JSON DSL evaluated by `packages/domain/rules`:

```json
{
  "name": "Aetna: modifier 25 required with E/M plus minor procedure same day",
  "scope": "payer", "payerId": "…",
  "kind": "validate", "severity": "block",
  "condition": { "all": [
    { "anyLine": { "codeIn": ["99212","99213","99214","99215"], "modifierNotIn": ["25"] } },
    { "anyLine": { "codeInGroup": "minor_procedures" } }
  ]},
  "action": { "finding": "Add modifier 25 to the E/M line", "suggestedFix": { "op": "addModifier", "lineMatch": { "codeInGroup": "em_established" }, "modifier": "25" } }
}
```

Supported actions: `finding`, `suggestedFix` (`addModifier`, `removeModifier`, `setField`, `reorderDiagnoses`, `setPayer`, `splitClaim`), `transform` (applied automatically when the rule is `kind: transform` and the client allows auto-transforms), `route` (send to a specific queue or assignee).

Seed rules: structural, NCCI, and a starter set Julia writes for the first specialty and top payers (`rules/seed/*.json`).

## Learning from corrections

When a biller edits a claim in review, each field change is saved to `corrections`. A nightly job groups identical corrections (same client-payer, same condition pattern, same change). When a pattern repeats N times (default 5) with no reversals, it proposes a rule. A tenant admin approves it in Settings › Rules (S-15); approved rules are `source: promoted`. Nothing is promoted without human approval.

## Denial triage

On denied or partially paid lines, map CARC/RARC and group code to a category: eligibility, authorization, coding, bundling, timely filing, duplicate, medical necessity, missing info, coordination of benefits, provider enrollment, other. Category drives the suggested fix and the work item queue. The LLM writes a two-sentence explanation of the specific denial in plain language and proposes a corrected claim when the category is fixable (coding, missing info, modifier). The corrected claim goes through scrub like any other version.

## Document AI

Insurance card front and back → `{ payerName, memberId, groupNumber, subscriberName, rxBin?, payerPhone?, planType? }` with per-field confidence. Payer name maps to a `payers` row by alias matching (Stedi's member ID card payer lookup is an option at $0.20 per lookup). Fields below 0.9 confidence or with no payer match go to review. Payer letters → classification (`denial`, `records_request`, `refund_request`, `recoupment`, `other`) plus extracted claim references; always to a work item.

## LLM usage rules (`packages/ai`)

- Access only through `@cleanpost/ai`; it enforces structured output (Zod schemas), retries on schema failure, timeouts and cost tracking per tenant.
- Model routing: a smaller, cheaper model for routine claim review and card extraction; a larger model for denial explanations and rule proposals. Model IDs are config.
- **Redaction:** claim review prompts use a de-identified view: no names, addresses, phone numbers, member IDs or full dates of birth (age in years only; dates of service kept). Card extraction necessarily sees the image and runs only on the BAA-covered provider in production.
- Prompts and outputs are not logged with PHI. Store prompt template ID, model, token counts, latency and the structured output (which contains no direct identifiers).
- Every AI suggestion shown in the UI is labeled as a suggestion and shows its evidence. Billers accept, edit or dismiss; the choice is recorded.
- Evaluation set in `packages/testing/ai-evals`: labeled claims and denials; run on every prompt or model change; block release if accuracy drops.
