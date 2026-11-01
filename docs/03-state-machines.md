# 03 — State machines

Implement each as a typed transition table in `packages/domain/state`. A transition function takes the current state, an event and context, and returns the new state plus side effects to enqueue. Invalid transitions return an error and are logged. Every transition writes a `claim_events` (or equivalent) row with the actor.

## Claim

```
draft ──build──► built ──scrub──► needs_review ──approve──► ready
                       │            │  └─edit──► built (new scrub)
                       │            └─block──► blocked ──fix──► built
                       └─scrub(auto)──────────────────────► ready
ready ──release──► submitted
submitted ──999 reject / 277CA reject──► rejected ──fix──► built (new version, freq 1)
submitted ──277CA accept──► accepted
accepted ──277 pending / no response──► accepted (status checks continue)
accepted ──835 paid──► paid ──balance to patient or zero──► closed
accepted ──835 partial──► partially_paid ──work item──► (closed | corrected)
accepted ──835 denied──► denied ──correct──► corrected (new version, freq 7) ──release──► submitted
                                 ──write off──► closed
any open state ──void──► voided (freq 8 sent if previously accepted)
paid/closed ──835 reversal (CLP02=22)──► reversed ──► accepted (await new adjudication)
```

Rules:
- `ready → submitted` requires either `scrub_result.decision = auto_release` with confidence ≥ the effective threshold, or a human approval event.
- Rejected claims were never adjudicated; fix and resubmit as frequency 1 with the same patient control number.
- Denied claims were adjudicated; corrections use frequency 7 with the payer claim control number.
- `filing_deadline` is computed at build from the client-payer timely filing days (default 90 for commercial, 365 for Medicare; configurable).

## Remittance

```
received ──parse──► parsed ──match──► matched | partially_matched
matched ──post──► posting ──success──► posted ──verify──► reconciled
                         └─failure──► post_failed ──retry/manual──► posting
partially_matched ──resolve unmatched (work item)──► matched
posted ──totals mismatch──► out_of_balance ──resolve──► reconciled
```

Mode A and C: `post` means "confirm the PM posted it" (read back from the PM). If the PM did not post or posted differently, create an exception work item; do not double-post.

## Posting (per remittance per connection)

`pending → in_progress → succeeded | failed | manual_required → succeeded`

`manual_required` creates a `manual_tasks` row and a work item with a pre-filled posting worksheet.

## Work item

```
open ──assign──► assigned ──start──► in_progress ──resolve──► resolved
open/assigned ──snooze(until)──► snoozed ──time passes──► open
any ──auto-resolve (underlying record fixed)──► resolved (actor = automation)
resolved ──reopen──► open
```

## Connection and sync

Connection: `setup → testing → healthy ⇄ degraded → failed → (fix) testing`, `paused` by admin.
- `degraded`: one operation failing or last success older than 2× schedule.
- `failed`: authentication failure or 3 consecutive failed runs. Alert tenant admin and platform operator.

## Client

`onboarding → ready_for_pilot → live ⇄ paused`, `offboarded` (data retained per contract, export provided).
`ready_for_pilot` requires the go-live checklist in `docs/13-cx-onboarding.md`.
