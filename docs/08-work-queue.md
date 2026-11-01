# 08 — Work queue

One queue per tenant across all clients. Billers see items for clients they are assigned to. The queue is the main screen of the product (W-01; side panels W-10 to W-24).

## Item types

| Type | Created when | Default priority | SLA (business hours) | Resolution actions |
| --- | --- | --- | --- | --- |
| `claim_review` | Scrub decision = review | 2 | 24h | Approve, edit then approve, hold, void |
| `claim_blocked` | Block finding | 2 | 24h | Fix field(s), re-scrub |
| `eligibility_issue` | Inactive or mismatched coverage | 1 | 4h if visit is upcoming, else 24h | Update coverage, re-check, mark self-pay |
| `card_review` | Card extraction below confidence | 3 | 48h | Confirm or correct fields |
| `rejection` | 999 or 277CA reject | 1 | 24h | Fix and resubmit |
| `no_response` | No 277CA or 835 after N days | 3 | 72h | Run status check, resubmit, contact payer |
| `denial` | Denied or partially denied line | by category: auth/eligibility 1, coding 2, other 3 | 48h | Accept suggested correction, edit, write off (reason), appeal (phase 2: draft) |
| `underpayment` (phase 2) | Paid below fee schedule | 3 | 5d | Dispute, accept |
| `remit_unmatched` | Claim or line unmatched | 2 | 24h | Link to claim, mark not ours |
| `out_of_balance` | 835 balance check fails (`docs/07-remittance-posting.md`) | 1 | 24h | Investigate, request corrected 835, accept difference (admin, with reason) |
| `mapping_needed` | Unmapped group/CARC for this PM | 1 | 24h | Map code (applies to all future postings) |
| `posting_exception` | Posting match fails: PM posting differs from the 835 (A, C; B from M7) | 2 | 24h | Correct in PM (manual or via adapter), accept |
| `manual_task` | Adapter operation at level 0 | from operation | 24h | Complete in PM, confirm |
| `timely_filing_risk` | Within 14 days of filing limit | 1 | 4h | Submit, document, escalate |
| `sync_failure` | Connection degraded or failed | 1 | 4h (admin) | Re-authenticate, pause, contact support |
| `system` | A job failed after 5 attempts (`docs/01-architecture.md`); platform operator alerted | 1 | 4h (admin) | Retry, open the affected record, contact support |

## Ordering

Default sort: priority, then due time, then dollar amount descending. Items within 4 hours of SLA show an amber due chip; past due shows red. Filters: client, payer, type, assignee, age, amount range, mode. Saved views per user ("My denials", "Aetna rejections").

## Assignment

- Auto-assign by client ownership (tenant admin sets primary and backup biller per client) or round-robin within a client group.
- Billers can claim unassigned items. Bulk assign, bulk snooze, bulk approve (claim review only, and only for claims whose findings are all `info`).

## Speed requirements

The queue must be fast to work from the keyboard:
- `J/K` next/previous item, `Enter` open, `A` approve, `E` edit, `S` snooze, `R` resolve with reason, `/` search, `?` shortcut help.
- Detail opens in a side panel without leaving the list; resolving moves to the next item automatically.
- Target: a routine claim review in under 20 seconds.

## Correction capture

Every edit made while resolving an item is written to `corrections` with before and after values (see `docs/06-rules-and-ai.md`). Resolution reasons are picked from a short list, plus optional free text.

## Auto-resolution

Items close themselves when the underlying condition clears (e.g. a later sync shows the PM posted the line correctly; a status check returns accepted). Actor recorded as `automation`.
