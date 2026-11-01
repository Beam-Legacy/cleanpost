# 09 — UI: information architecture, screens and flows

Design intent: a calm, dense, fast tool for people who work a queue all day. Every screen answers three questions at a glance: what needs me, why, and what happens if I do nothing. Visual rules are in `docs/10-design-system.md`. The designs for every screen, modal, drawer and state are in `ui/` (open `ui/index.html`). Their IDs (W-01, C-08, ...) supersede the S-numbers below where they differ; each design's spec block lists purpose, data, actions, states and rules.

## Navigation

Left sidebar (collapsible to icons), top bar with client switcher, global search (`⌘K`), notifications and user menu.

```
Work            (S-02)  badge = items assigned to me
Claims          (S-05)
Remittances     (S-10)
Denials         (S-13)
Patients        (S-06 via search)
Clients         (S-08)  admin and billers
Reports         (S-14)
Integrations    (S-16)  admin
Settings        (S-15)  admin
```

The client switcher filters every screen to one client or "All clients" (default for billers with several clients). The current filter is always visible in the top bar.

## Universal patterns

- **Status chips** use one vocabulary everywhere (Draft, Needs review, Blocked, Ready, Submitted, Accepted, Rejected, Paid, Partially paid, Denied, Corrected, Closed, Voided).
- **Mode badge** (A, B, C) on every claim and client, with a tooltip explaining the mode in one line.
- **Actor attribution**: every event shows who or what did it ("Auto-released by rule set v14", "Approved by Dana R.").
- **Money** right-aligned, tabular figures, cents always shown in detail views, rounded to dollars in summaries.
- **PHI minimization**: lists show patient name as "Last, F." and age; full DOB and member ID only in detail views, with a reveal control that is audit-logged.
- **Empty states** say what will appear here and what to do next. **Error states** say what failed, whether data is safe, and the next action. **Loading** uses skeletons, never spinners on full pages.
- **Undo** for 10 seconds on approve, snooze and resolve (except actions that already sent data to a payer or PM; those ask for confirmation instead).
- **Session timeout** after 15 minutes idle with a 60-second warning; unsaved edits are kept locally (no PHI in local storage: only field paths and values for the open claim, cleared on logout).

---

## S-01 Sign in and MFA

Email and password, then TOTP or passkey. First sign-in forces MFA enrollment. "Trust this device for 12 hours" only on tenant-approved devices. Lockout after 5 failed attempts with an email to the user. No PHI on any auth screen.

## S-02 Work queue (home)

Purpose: the biller's day. Layout: summary strip, filter bar, list, detail side panel.

- **Summary strip** (per current client filter): Due today, Overdue, Ready to release, Claims released today, Payments posted today ($), Automation rate today.
- **Filter bar**: type chips with counts (Review, Rejections, Denials, Posting, Eligibility, Manual tasks, Other), client, payer, assignee (Me, Unassigned, Anyone), saved views.
- **List columns**: priority marker, type, client, patient ("Last, F."), payer, amount, reason (one line, plain language), age, due chip, assignee.
- **Side panel** (opens on select; `Enter` for full page): context-specific body (claim review renders S-03 compact; denial renders S-13 card; posting exception renders the diff from S-11), primary action button, secondary actions, "Why is this here?" explanation with rule or code reference.
- **Bulk bar** appears on multi-select: assign, snooze, approve (eligible claim reviews only).
- Empty state: "Nothing needs you right now. 412 claims went out automatically today."

## S-03 Claim detail

Header: patient, DOS, payer, total charge, balance, status chip, mode badge, client, patient control number, filing deadline (amber within 14 days).

Tabs or sections:
1. **Summary**: AI summary in plain language (labeled "Suggested summary"), findings list grouped by severity with the rule name and a fix button where a `suggestedFix` exists.
2. **Lines**: table of lines (code, modifiers, units, charge, diagnosis pointers, allowed, paid, adjustments, balance). Diagnoses listed with sequence. Codes only, no CPT descriptions (licensing).
3. **Timeline**: every claim event with time, actor and payload summary (e.g. "277CA accepted by Availity, 2:14 pm", "835: paid $84.12, PR-2 coinsurance $21.03").
4. **Versions**: list of versions with frequency code, diff between versions.
5. **Patient and coverage**: subscriber, payer, member ID (masked, reveal logged), eligibility result with date, card images.
6. **Remittances**: linked remit claims with links to S-11.

Actions by status: Needs review → Approve and release / Edit / Hold / Void. Rejected or Denied → Build correction (opens S-04 prefilled with suggested fix). Submitted/Accepted → Check status now (276). Any → Add note.

## S-04 Claim editor

Opened from review or correction. Two columns: editable claim form (sections: billing provider, rendering provider, subscriber and patient, payer, diagnoses, lines) and a live findings panel that re-runs the scrub on each change (debounced) and shows the confidence score updating. Changed fields are highlighted, and the footer lists every change made ("Line 2 modifier 25 added"). Save creates a new version; "Approve and release" saves, scrubs and releases if no block findings remain. For corrections the frequency code (7) and original payer claim number are set automatically and shown read-only.

## S-05 Claims list

Table with saved views (All open, Needs review, Rejected, Denied, Awaiting payment > 30 days, Filing deadline < 30 days). Columns: patient, DOS, client, payer, charge, paid, balance, status, mode, age, last event. Column picker, CSV export of non-PHI fields (PHI export requires admin role and is audit-logged).

## S-06 Patient detail

Demographics, coverages ordered by priority with eligibility status and last check time ("Check now" button), card images with extraction results, encounters and claims history, balance summary. Edits here write back to the PM through the adapter (or create a manual task) and say so before saving.

## S-07 Client onboarding wizard

Full-page stepper with progress saved at each step. Steps:

1. **Practice**: legal name, tax ID, billing NPI, taxonomy, address, timezone.
2. **Providers and locations**: add NPIs (NPPES lookup fills names), locations with place of service.
3. **PM system**: pick from list (with logo-free text labels) or "Other". Shows what Cleanpost can do with that PM today, per operation, with the level (Official API, File, Managed API, Browser, Manual) and what each means for the billing company's workload.
4. **Connect**: credential form specific to the adapter (e.g. Tebra customer key and API user) or file setup or "Start manual". "Test connection" runs `healthCheck` and a dry-run pull of the last 7 days (counts only).
5. **Payers**: pull payer list from recent PM data; map each to a Stedi payer; set timely filing days; see enrollment requirements.
6. **Mode**: recommended mode with the reason (from the capability matrix in `docs/04-modes.md`), the other available modes with trade-offs, and per-payer overrides. Choosing B shows an ERA enrollment plan per payer with status tracking (Stedi enrollment API); until a payer's enrollment is active, it runs as C. Choosing B or C requires confirming that the PM's own electronic submission is disabled for this client, or that the adapter supports `markChargeBilled`.
7. **Posting rules**: adjustment mapping table prefilled from the PM-type defaults; admin reviews unmapped codes.
8. **Automation**: auto-release threshold (slider with plain-language explanation: "At 90, about N of last month's claims would have gone out without review" computed on the dry-run data), start in "Review everything" mode (recommended for the first 2 weeks).
9. **Go-live checklist**: all items must be checked (see `docs/13-cx-onboarding.md`). "Go live" sets the client to `live` and starts syncing on schedule.

## S-08 Clients list

Cards or table: client name, PM, mode, status, claims this month, first-pass acceptance, automation rate, open items, connection health dot. "Add client" opens S-07.

## S-09 Client overview

Header with status, mode, PM, connection health. Tabs: Overview (KPIs and trends for this client), Settings (thresholds, mode, payer settings), Providers, Payers, Mappings, Activity. Admins can pause a client (stops releases, keeps syncing).

## S-10 Remittances list

Columns: payment date, payer, trace number, method, amount, claims count, source (Stedi, PM, File), match status, posting status, balance status. Upload button for 835 files (drag and drop; validates, shows parse summary before ingest).

## S-11 Remittance detail and posting

Header: payer, trace, amount, date, source, status. Balance bar: "Payment $12,480.11 = claims $12,502.31 − provider adjustments $22.20 ✓".
Body: list of claims in the remit, each expandable to lines with paid, allowed, adjustments (group-CARC chips with plain-language tooltip, e.g. "CO-45: amount above the contracted rate, written off"), RARC remarks, mapped PM adjustment code, patient responsibility.
- Mode B: posting status per claim (Posted, Failed, Manual) and a "Post now" action.
- Modes A/C: verification view, a side-by-side diff of "835 says" versus "PM posted", with differences highlighted and a resolve action per line.
Unmatched claims sit at the top with a "Link to claim" search.

## S-12 Manual task

Instructions written for the specific PM where known ("In Tebra: Encounters › Find encounter 10443 › Charges tab"), a worksheet table to copy from (copy buttons per value), attachments (generated CSV/PDF), and a "Done" confirmation that asks for the PM reference (e.g. PM payment ID). Optional "I couldn't do this" with reason, which escalates.

## S-13 Denials

Grouped by category (Eligibility, Authorization, Coding, Bundling, Missing info, Timely filing, Duplicate, COB, Enrollment, Other) with counts and dollars. Each denial card: claim, payer, CARC/RARC with plain explanation, AI explanation, suggested next step, amount at risk, days until appeal deadline (if known). Actions: Build correction, Write off with reason, Mark for appeal (phase 2), Reassign. Trend chart: denials by category over 12 weeks.

## S-14 Reports

Tenant view and client view with the same layout. Date range picker. KPIs with definitions on hover:
- Charges, payments, adjustments ($)
- First-pass acceptance rate
- Clean claim rate (accepted and paid without correction)
- Denial rate (by count and $) and top denial reasons
- Days in A/R and A/R aging by payer (0–30, 31–60, 61–90, 91–120, 120+)
- Charge-to-submission and remit-to-posted medians
- Automation rate (claims released without touch; ERA lines posted without touch)
- Work items created and resolved per biller (tenant admin only)
Every report exports to PDF (branded with the billing company's name and logo for client reviews) and CSV.

## S-15 Settings (admin)

- **Users and roles**: invite, roles, client scope, MFA status, deactivate.
- **Automation**: tenant default threshold, per-client overrides summary, auto-transform toggles.
- **Rules**: list with scope, source, hit count, last 30 days precision (overrides by billers); proposed rules from corrections with evidence (examples) and Approve or Dismiss.
- **Adjustment mappings**: per PM type and per client.
- **Notifications**: which events notify whom (in-app, email digest), quiet hours.
- **Branding**: logo and name used on client reports.
- **Billing and usage**: claims this period by client and mode, invoices.
- **Security**: session length, IP allowlist (optional), device trust, audit log access (S-19).

## S-16 Integrations

Per client connection: adapter, level per operation (matrix), last successful sync per operation, error rate, next scheduled run, "Run now", "Re-authenticate", "Pause". Sync run history with counts and error codes (no PHI). Failed connections are pinned to the top.

## S-17 Notifications

In-app list and daily email digest. Event types: SLA breach, connection failure, large denial (over a set amount), out-of-balance remittance, rule proposals waiting, client go-live complete. Emails never contain PHI; they link into the app.

## S-18 Global search (⌘K)

Search patients (name, DOB), claims (patient control number, payer claim number), remittances (trace number), clients, and commands ("Go to denials", "Upload 835"). Results respect client scope. Searches are audit-logged.

## S-19 Audit log (admin)

Filter by user, action, entity, date. Shows who viewed or changed what. Export for compliance requests.

## S-20 Platform operator console (Cleanpost staff only)

Tenants, connection health across tenants, job queue depth and failures, webhook backlog, Stedi and Bedrock error rates, usage. **No PHI is ever rendered here**: records shown by ID and counts only. Break-glass access to a tenant requires a reason, tenant notification and expires after 1 hour; every action is audited.

## S-21 Client portal (phase 2)

Read-only for practice staff: their KPIs, claims status, denials summary, monthly report download. Branded with the billing company's name.

---

## Key flows

### Flow 1: Onboard a client in Mode A (target: under 1 hour of admin time)
S-08 Add client → S-07 steps 1–9 → PM chosen supports holdCharge → Mode A recommended → Review-everything for 2 weeks → Go live → first sync appears in S-16 → claims appear in S-02 as `claim_review`.

### Flow 2: Daily loop, Mode A
Morning: S-02 shows overnight items. Biller works claim reviews (approve or fix; fixes write back to the PM via `pushChargeCorrection`) → claims released in the PM → PM's clearinghouse sends → acknowledgments arrive via sync → rejections appear as items. Afternoon: posting exceptions from the PM's auto-posting (S-11 diff) and denials (S-13).

### Flow 3: Daily loop, Mode B
Same front half, but release submits through Stedi; 999 and 277CA arrive by webhook within about 30 minutes; 835s arrive by webhook and post automatically; exceptions (unmatched, out of balance, mapping needed, post failed) land in S-02.

### Flow 4: Daily loop, Mode C
Release submits through Stedi (as B); 835s arrive in the PM and are verified (as A).

### Flow 5: Denial to corrected claim
S-02 denial item → side panel shows CO-4 (modifier inconsistent) with AI explanation and suggested fix "Add modifier 59 to line 2" → Build correction → S-04 opens with the fix applied, frequency 7 set → scrub passes → Approve and release → timeline shows the correction; the denial item auto-resolves when the corrected claim is accepted.

### Flow 6: Manual posting (no integration yet)
835 arrives (Stedi or upload) → matched and balanced → client's adapter is manual for `postPayment` → manual task created with worksheet → biller posts in the PM using S-12 → confirms with PM payment ID → next `pullPostings` (if available) verifies; otherwise marked posted by user.

### Flow 7: Switch a client from Mode A to Mode B
S-09 Settings › Mode → choose B → enrollment plan per payer (Stedi enrollment API) → payers move to B individually as ERA enrollment becomes active, running as C in the meantime → confirm PM electronic submission disabled → in-flight claims finish in A.
