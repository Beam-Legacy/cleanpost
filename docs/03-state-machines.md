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
- Work items: `assigned → open` (`unassign`) when an item goes back to nobody (W-05).
- `built | needs_review | blocked | ready → on_hold` (`hold`, C-12) and `on_hold → built` (`unhold`, scrubbed again). A held claim keeps its hold through new versions (`edit` stays `on_hold`) and is never released.
- `ready → needs_review` (`unapprove`) is the 10-second Undo of a person's approval (docs/09-ui-screens.md), only while the release has not gone out; it cancels the queued release and reopens the review item. An approval counts only if no later `unapproved` event exists for the same version.
- `ready → submitted` requires either `scrub_result.decision = auto_release` with confidence ≥ the effective threshold, or a human approval event.
- `built | needs_review | blocked | on_hold | ready | corrected → submitted` (`billed_outside`, Mode A): the PM shows the claim sent although Cleanpost did not release it (a biller approved it in the PM, or a PM with no hold billed it at its batch time). Recorded as a `released` event with `via: pm_outside_cleanpost`; open review and blocked items for the claim close themselves. It is the PM's record of what happened, not a release by Cleanpost.
- Rejected claims were never adjudicated; fix and resubmit as frequency 1 with the same patient control number.
- Denied claims were adjudicated; corrections use frequency 7 with the payer claim control number.
- `filing_deadline` is computed at build from the client-payer timely filing days (default 90 for commercial, 365 for Medicare; configurable).

## Remittance

```
received ──parse──► parsed ──835 balance check──► balanced | out_of_balance
out_of_balance ──admin accepts difference (reason)──► balanced   (only claims that balance on their own continue)
balanced ──match──► matched | partially_matched
partially_matched ──resolve unmatched (work item)──► matched
matched ──post (B)──► posting ──success──► posted ──posting match──► reconciled | posting_mismatch
                             └─failure──► post_failed ──retry/manual──► posting
matched ──verify (A, C)──► verifying ──posting match──► reconciled | posting_mismatch
posting_mismatch ──resolve every posting_exception──► reconciled
```

The two checks are named in `docs/07-remittance-posting.md`: the **835 balance** check (before anything is posted or verified) and the **posting match** (after the PM or Cleanpost posts). `out_of_balance` always means the 835 itself does not balance (W-18 and R-06 "835 does not balance"); a posting that differs from the 835 is `posting_mismatch` (R-04 "PM posting does not match").

Mode A and C: Cleanpost does not post; `verify` reads the PM's postings back. If the PM did not post or posted differently, create a `posting_exception` work item; do not double-post. If the PM does not post the remittance at all, a manual posting task is created instead (`docs/04-modes.md`).

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

`onboarding → live ⇄ paused`; `live | paused → offboarded` (CL-11: export generated first, syncing stops, credentials disconnected, data retained read-only per contract).
`onboarding → live` happens only through Go live (O-10), which requires every item of the go-live checklist in `docs/13-cx-onboarding.md`.
