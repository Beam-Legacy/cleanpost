# 00 — Product overview

## What it is

Cleanpost is software billing companies use to run their clients' revenue cycle: pull coded charges from each practice's PM system, check eligibility, build and scrub claims, submit, track, ingest remittances, post payments back to the PM, and work denials. Billers handle only the exceptions.

## Who pays and who uses it

| Role | Description |
| --- | --- |
| Tenant | A billing company. Pays Cleanpost per claim plus a monthly base fee. |
| Client | A medical practice the billing company serves. Has its own PM, NPIs, payers and settings. |
| Tenant admin | Billing company owner or manager. Onboards clients, sets automation thresholds, manages users. |
| Biller | Works the queue across assigned clients. |
| Client viewer (phase 2) | Practice staff with read-only access to their own reports. |
| Platform operator | Cleanpost staff. Monitors integrations and jobs. No routine PHI access; break-glass access is logged and time-limited. |

## Value proposition

"Each biller handles two to three times more clients." Claims go out clean and fast, payments post the day they arrive, every denial gets worked, and the billing company sees everything in one place.

## Submission modes (set per client, per payer override allowed)

| Mode | Claims go out through | 835s come back through | Who posts payments | When to use |
| --- | --- | --- | --- | --- |
| A — PM-native | The client's PM and its clearinghouse | The PM's clearinghouse; PM auto-posts | PM auto-posts; Cleanpost reviews and works exceptions | Default. Fastest onboarding, no payer re-enrollment. |
| B — Platform | Cleanpost via Stedi | Stedi (ERA enrollment moved to Stedi) | Cleanpost posts into the PM | Full control and best data. Requires ERA re-enrollment per payer. |
| C — Hybrid | Cleanpost via Stedi | The PM's clearinghouse (unchanged) | PM auto-posts; Cleanpost reads remits from the PM | PM's claim submission is weak or unavailable, but ERA enrollment should not move. |

Details: `docs/04-modes.md`.

## MVP scope

In:
- Tenants, clients, users, roles, MFA, audit log
- Integration hub with adapter contract; reference PM mock adapter; manual adapter; CSV/X12 file adapter; stub adapters for Tebra, athenaOne, AdvancedMD, ModMed, SimplePractice, eClinicalWorks, DrChrono, CollaborateMD, Office Ally
- Canonical data model
- Eligibility (270/271) via Stedi
- Insurance card capture and extraction
- Rules engine, claim builder, scrubber, LLM explanation, confidence scoring, auto-release
- Submission: Mode A via adapter for the pilot; Modes B and C via Stedi after the pilot (`docs/17-decisions.md` DEC-01)
- Claim tracking: 999, 277CA, 276/277, timely-filing watch
- Remittance ingestion (PM read and file upload; Stedi webhook with Modes B and C), matching, adjustment mapping, verification and posting, reconciliation
- Denials categorization with suggested fix and corrected-claim builder
- One work queue across clients
- Reports per client and per tenant; usage metering
- Client onboarding wizard with mode selection and go-live checklist
- Platform operator console (integration health, jobs) without PHI
- Transactional emails (E-01 to E-07) and PDFs (F-01 to F-03), with no PHI in any email

Built alongside, off the pilot path: the marketing website, a static site (`apps/website`, DEC-05).

Out of MVP (later):
- AI coding from clinical notes
- Appeal letter drafting and payer portal submission
- Patient statements and payments
- Credentialing and provider enrollment
- Client-facing portal (phase 2)
- Prior authorization
- Payer phone calls (voice agents)

## Success metrics for the pilot

- First-pass acceptance (277CA accepted / submitted) ≥ 95%
- Claims released without human touch ≥ 60% by end of pilot, rising after
- ERA lines posted without human touch ≥ 90%
- Charge-to-submission median < 24 hours
- Remit-to-posted median < 24 hours
- Biller minutes per claim down ≥ 50% vs the partner's baseline

## Document index

| Doc | Covers |
| --- | --- |
| 01-architecture | Services, repo layout, jobs, environments |
| 02-data-model | Tables and relationships |
| 03-state-machines | Claim, remittance, posting, work item, sync lifecycles |
| 04-modes | Modes A, B, C end to end |
| 05-adapters | Adapter contract, capability levels, mock and stub adapters |
| 06-rules-and-ai | Rules engine, scrubber, confidence, LLM use |
| 07-remittance-posting | 835 handling, matching, adjustments, reconciliation |
| 08-work-queue | Item types, priority, SLAs, correction capture |
| 09-ui-screens | Every screen, its data, actions and states |
| 10-design-system | Visual design, tokens, components, accessibility |
| 11-security-hipaa | Security controls and HIPAA safeguards |
| 12-testing | Synthetic data, payer simulator, contract tests |
| 13-cx-onboarding | Onboarding, notifications, help, support |
| 14-api | Internal API and webhooks |
| 15-integrations-reference | Stedi endpoints, X12 reference, code sets |
| 16-milestones | Build order with acceptance criteria |
| 17-decisions | Decisions that changed the spec, and open questions |

The designs for every view, email, PDF and website page are in `ui/` (open `ui/index.html`).
