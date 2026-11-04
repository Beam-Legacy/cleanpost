# 17 — Decisions log

Every decision that changes the spec gets an entry here, in the same commit as the doc changes it causes. Newest last. IDs use `DEC-` so they never collide with view IDs.

## DEC-01 — Mode A first; Modes B and C after the pilot (Nov 1, 2026)

- **Decision:** Build the full cycle for Mode A before the pilot. Keep Mode B and C seams (contract operations, `claims.mode`, state machines, `client_payer_settings`), but build Stedi claim submission, 999/277CA/835 webhooks, Mode B posting, ERA enrollment and 837 secondaries in M7, after the pilot.
- **Why:** The financial model has 0% of claims on Modes B and C through the pilot. Mode A is the default for onboarding and needs no payer re-enrollment.
- **Exception:** If the Tebra test shows Mode C is the better pilot mode, the Mode C submission path moves into M6 (estimate 2–3 weeks).
- **Affects:** `00-overview.md`, `04-modes.md`, `12-testing.md`, `16-milestones.md`; `ui/README.md` already marks R-03 and CL-10 as after the pilot.

## DEC-02 — The Tebra test decides Mode A or Mode C for the pilot (Nov 1, 2026)

- **Decision:** Run a read-only Tebra test as soon as test access exists (track in `16-milestones.md`). Its results decide the pilot mode.
- **Expected outcome from the published API (April 2026 guide and public WSDL):** Mode A. Tebra can approve encounters through the API (`UpdateEncounterStatus` Review → Approved), which gives Cleanpost a hold and release, but has no way to mark a charge billed, so Mode C would require turning off Tebra's electronic claim submission. Details in `05-adapters.md` and `15-integrations-reference.md`.
- **Open:** Test access. Tebra publishes no sandbox; access needs a Tebra account's system administrator to request a customer key from Tebra Customer Care. Ask the design partner for a test practice with synthetic patients only, and ask Tebra directly for a developer or demo account.

## DEC-03 — Preview hosting on Railway; production on AWS (Nov 1, 2026)

- **Decision:** Preview environments run on Railway with synthetic data only (no BAA needed). Staging and production run on AWS under the AWS BAA.
- **Affects:** `01-architecture.md` (Environments).

## DEC-04 — Stedi sandbox key by M2 (Nov 1, 2026)

- **Decision:** Have the Stedi sandbox key before M2. M2 builds the Stedi eligibility client (270/271) and the `eligibility.check` job, because scrub step 2 needs coverage status. The eligibility screens stay in M4.
- **Affects:** `README.md`, `16-milestones.md`.

## DEC-05 — Marketing website is static and off the pilot path (Nov 1, 2026)

- **Decision:** The website (WEB- designs) is a separate static site in `apps/website`, using the same tokens. It never blocks a milestone. The status page (WEB-13) is a hosted status service.
- **Affects:** `00-overview.md`, `01-architecture.md`, `16-milestones.md`.

## DEC-06 — `ui/` view IDs replace the old S-numbers (Nov 1, 2026)

- **Decision:** The `ui/` IDs are the only screen IDs. The old S-01 to S-21 numbers are retired because `ui/` uses S-01 to S-14 for Settings screens. `09-ui-screens.md` keeps a crosswalk from the old numbers.
- **Affects:** `04`, `06`, `07`, `08`, `09`, `13`, `16`.

## DEC-07 — Spec contradictions resolved (Nov 1, 2026)

| Topic | Resolution | Docs |
| --- | --- | --- |
| Client status | `onboarding → live ⇄ paused → offboarded`. The go-live checklist gates `live` (O-10's Go live sets `live` directly). `ready_for_pilot` is dropped. | 02, 03, 13 |
| Connection status | `setup → testing → healthy ⇄ degraded → failed`, `paused`; `testing` added to the data model. | 02, 03 |
| Balancing | Two named checks, as in W-18 and R-06: **835 balance** (before anything is posted or verified; failure blocks posting) and **posting match** (after the PM or Cleanpost posts; differences become `posting_exception` items). The remittance state `out_of_balance` means the 835 balance check failed; `posting_mismatch` means the posting match failed. | 03, 07 |
| Job failures | New work item type `system` for a job that failed after 5 attempts, shown to tenant admins with the affected record; the platform operator is alerted. | 08 |
| `tenant_id` | Denormalized onto every customer-data table, including child tables (`claim_lines`, `remit_adjustments`, ...), so every RLS policy is a single column check. | 02 |
| Users and auth | `users` and better-auth's own tables (sessions, accounts, verification, two-factor, passkeys) are global, hold no PHI and are reached only through the auth module. `memberships` has an extra policy so a user can list their own memberships before choosing a company (A-07). | 02, 11 |
| Patient control number in Mode A | In Mode A the PM's clearinghouse assigns CLM01. `claims.patient_control_number` stores whichever number goes to the payer, with `claims.pcn_source` (`cleanpost` or `pm`). For `pm`, the number is read back from the PM before release when the adapter can, otherwise after the first claim status pull; matching falls back to steps 2 and 3 until then. | 02, 07 |
| Data the designs use but the model lacked | Added: tenant profile and contacts (S-14), `tenant_agreements`, `exports`, `invoices`, `integration_requests`, `break_glass_grants`, `platform_banners`, `user_preferences`, `saved_views`, `notification_rules`, `clients.pm_batch_time`, `remit_claims.matched_by`. | 02 |
| Operations with no manual fallback | Some operations cannot be done by hand in a useful way (holding a charge in a PM with no hold). Capability values are 0–4 or `unavailable`, matching I-02's "Not available in this PM". | 05, contract |

## DEC-08 — Tebra findings shape the adapter contract (Nov 1, 2026)

- **Decision:** Sync schedules and rate limits are per adapter, not one global default: the contract gains a `syncPolicy`. Several clients may share one PM account (Tebra billing-company accounts), so connections carry a `pm_account_ref` that groups shared credentials and rate limits. Where a PM requires an over-privileged API user (Tebra requires System Admin), the dedicated user rule still applies and the gap is recorded in the adapter README.
- **Affects:** `02-data-model.md`, `05-adapters.md`, `15-integrations-reference.md`, `starter/packages/adapters/src/contract.ts`.

## DEC-09 — M0 implementation choices (Nov 1, 2026)

| Topic | Choice | Why |
| --- | --- | --- |
| TypeScript | 6.0 (not 7.0) | typescript-eslint supports up to 6.0; revisit when it supports the native compiler. |
| Component styles | `packages/ui` copies `ui/assets/tokens.css` and `components.css` unchanged; React components emit those classes on Radix primitives; `app.css` holds runtime additions | The design export stays the single source of visual truth and can be re-copied after design changes. |
| Fonts | Self-hosted at build time with `next/font` | Loading Google Fonts in users' browsers would send their IP addresses to Google. |
| Telemetry | Off for better-auth, Next.js and Storybook | No usage data leaves our infrastructure. |
| Test databases | One per package (`cleanpost_test_<package>`), rebuilt from migrations before each run | Turbo runs package suites in parallel. |
| Second factor setup (A-03) | Asks for the password again before showing the QR code | better-auth requires it to enable TOTP; the design shows no password field. |
| Lockout (A-08) | 5 wrong passwords lock sign-in for 15 minutes; the user is emailed | The design gives no duration; 15 minutes is a common default. |
| Deferred from M0 | A-06 Accept invite moves to M5 with S-02 Invite user; strict nonce-based CSP lands with the first PHI screens (M2). The Railway preview went live on Nov 1, 2026 (see `docs/01-architecture.md`) | Invites need the invite-creation flow; CSP is easier to tune against real screens. |

## DEC-10 — Preview may skip two-factor setup (Nov 1, 2026)

- **Decision:** In the preview, the two-factor setup screen (A-03) offers "Skip for now", which lets that one session in; the next sign-in shows the step again. People can still set up real two-factor. Turned on by `PREVIEW_ALLOW_SKIP_2FA=true`.
- **Why:** Demos to people without an authenticator app at hand. The preview holds synthetic data only.
- **Guardrails:** The flag is a startup error unless `CLEANPOST_ENV` is `local` or `preview`, and the skip function refuses to run without it. Remove the flag before any environment that could hold PHI exists; staging and production cannot enable it.
- **Affects:** `packages/config`, `packages/auth/src/session.ts`, A-03 (`apps/web`), `sessions.second_factor_skipped_at`.

## DEC-11 — M1 sync and mock PM choices (Nov 2, 2026)

| Topic | Choice | Why |
| --- | --- | --- |
| Synthetic generator | Own seeded PRNG and specialty profiles in `packages/testing/synth`, not Synthea or Faker | Deterministic, small, and every value comes from the scanner's known pools. Synthea can come later for clinical realism. |
| Pediatric ages | 11–17 in the generator | The PHI scanner recognises dates of birth from 1930 to 2015 only; widening it would flag dates of service. |
| Mock PM data | Its own `pm_mock` schema with its own migrations table; Cleanpost's app role has no access | It stands in for a third-party PM: Cleanpost reaches it only through the adapter, like a real one. |
| Mock PM credentials | Account keys derived from `PM_MOCK_SECRET`; connections hold `pm-mock:<account>` | No keys copied between services; the mock adapter and pm-mock refuse staging and production. |
| Scheduler | `sync.tick` every minute reads `app.sync_candidates()`, a security-definer function returning IDs and schedule fields only | The only cross-tenant read the app role has; everything else runs in each connection's tenant. Recorded in `11-security-hipaa.md`. |
| Rate limiter | Token buckets in Postgres (`rate_limit_buckets`, tenant RLS) | Shared by every worker process without another service. |
| Contract suite | `markChargeBilled` may be `unavailable` | Matches `docs/05-adapters.md`; Tebra has no way to mark a charge billed. The suite had been stricter than the docs. |
| Contract `Page` | Gains `rejected` (PM record ID and field) | Records the adapter cannot read are reported, never silently dropped, and never by value. |
| Encounter status | PM "billed" maps to canonical `ready`; the PM's own status is kept in `encounters.pm_status` | `claimed` means Cleanpost built a claim (M2); M2's builder will use `pm_status` to skip encounters the PM billed before go-live. |
| Job queue | pg-boss in its own `pgboss` schema, installed by `pnpm db:migrate`; apps connect as the app role with migrate off | The app role never needs DDL rights on the main schema. |
| Pulls in M1 | Patients and charges only | Claim status, remittances and postings are pulled once M2 and M3 have the code that applies them. |

## DEC-12 — M2 scrub and AI choices (Nov 2, 2026)

| Topic | Choice | Why |
| --- | --- | --- |
| Claim payload | Patient, coverage and payer by ID; no names, addresses or member IDs in `claim_versions.payload` | Field encryption stays meaningful; Modes B and C keep the rendered 837 as the snapshot at release. |
| PM-billed encounters | No claim is built for an encounter the PM already sent (Tebra `Approved`, generic `billed`) | Cleanpost cannot hold or change it; it is tracked through the PM's claim status. |
| Northwind modes in the seed | All Mode A until M7 | `docs/12-testing.md` and DEC-01; the designs' B and C badges come back with M7. |
| Duplicate check | Against the patient's other live visits that day, not only claims | A duplicate of a visit the PM billed itself has no Cleanpost claim to compare with. |
| Reference data | A synthetic subset in `rules/seed/reference.json` (code sets, NCCI pairs, MUE limits) | Until the CMS files load at deploy time (open AMA question). |
| AI models | Bedrock via the Anthropic SDK's Mantle client: `anthropic.claude-haiku-5-5` (effort `low`) for routine claim review, `anthropic.claude-opus-5-5` for denials and rule proposals | docs/06 model routing: a smaller model for routine review, a larger one where the reasoning is harder. Config, not code. |
| AI without credentials | A deterministic stand-in in local and preview; off in staging and production until Bedrock is configured | The pipeline, scoring and UI can be built and shown without AWS access. |

## DEC-13 — M2 work queue and edit choices (Nov 2, 2026)

| Topic | Choice | Why |
| --- | --- | --- |
| Undo on approve | Approve-and-release queues `claim.release` 10 seconds out; Undo cancels the job and moves the claim `ready → needs_review` (`unapprove`), reopening the review item. An approval counts only without a later `unapproved` event for that version. | docs/09 asks for Undo on approve, and nothing may have reached the PM when it is used. A confirm dialog on every approval would break the 20-second review. |
| Where PM write-back runs | The web app saves the edit (new version, `corrections` rows) and queues `claim.correct`; the worker calls `pushChargeCorrection` or opens the correction task | docs/01: adapters run in the worker. Release waits for `correction_requested` to be answered by `correction_pushed` or `correction_manual` (and, for a task, until it closes). |
| Re-scrub after an edit | In place in the web request, without the AI step | W-10 shows the new score at once; a person is reviewing the claim, and the AI step stays in the worker. |
| Queue reason | The work item summary is the claim's top warning (or block), else the first-claim or threshold reason | W-01 shows a plain-language reason per row. |
| Assignee filter | Defaults to Anyone in the user's client scope | Auto-assignment by client ownership arrives with settings (M5); "Me" would show an empty queue until then. |
| Snooze | Presets (3 hours, tomorrow 8 am, next Monday 8 am, Pacific) and a date and time; at most 30 days. Woken lazily as automation when the queue loads. | W-06 condition snoozes (next sync, payment, eligibility) need those events first (M3, M4). |
| Not yet in the panel | Hold (C-12), bulk bar (W-04), save view (W-08), assign (W-05) | Second pass of M2-F. |
| C-08 editor scope | Codes, modifiers, units, pointers, diagnoses, prior authorization and place of service; lines can be removed, not added; charges, patient, payer, providers and dates are read-only | Mode A: the PM holds the charge; a new line or a new amount is entered there and arrives by sync. |
| C-08 live findings | The deterministic scrub steps on the unsaved payload (`previewScrub`), 400 ms after the last change; nothing is written until Save | The editor shows the effect of a change before it becomes a version. |
| C-05 "What changed" | Each version diffed against the one before (`diffPayload`), for person and PM versions alike | Exact and complete; the `corrections` rows remain the record of who changed what. |

## DEC-14 — Eligibility before the Stedi key (Nov 2, 2026)

| Topic | Choice | Why |
| --- | --- | --- |
| Building without the key | One client (`packages/eligibility`) for Stedi's 270/271 JSON; payer-sim serves the same path from the payers' member files | The scrub's step 2 and the job chain work now; switching to Stedi is configuration (`STEDI_API_KEY`). |
| When a check runs | Before the scrub of a built claim whose coverage has no check in 7 days; the scrub waits for it | Scrub step 2 needs the answer; a check per coverage per week keeps cost near Stedi's per-check price times patients seen. |
| What is stored | `eligibility_checks.summary`: status, plan dates, copay, deductible remaining, coinsurance, AAA codes; no identifiers. The raw 271 waits for object storage (M3) | PHI stays in the database and encrypted storage only; the summary is all scrub step 2 and P-03 need. |
| Payer IDs in the synthetic world | Simulator IDs (`SIMAETNA`, ...) on the seeded payers | Real Stedi payer IDs come from Stedi's payers API at onboarding. |
| Inactive coverage | Blocks the claim through scrub step 2 (`claim_blocked`), no separate `eligibility_issue` item yet | One item per problem; the eligibility panel (W-13) arrives in M4. |

## DEC-15 — Void before release only, in M2 (Nov 2, 2026)

- **Decision:** C-13 voids claims that were never sent (draft to ready): status Voided with the reason, open items closed. A claim the payer has needs a void claim (frequency 8); in Mode A the PM sends it, and Cleanpost adds that path with corrections in M4. The dialog tells the biller to reject the encounter in the PM too, so the PM never bills it.
- **Also:** notes (C-16) are claim events of type `note`, shown on the timeline to users with access to the client; the audit row records the length, not the text. G-12 reveals write `phi.revealed` or `phi.copied` with the field name.

## DEC-16 — Write-off approval, amounts and the corrected-claim deadline (Nov 2, 2026)

- **Decision:** D-03 "Request approval" is a `write_off_requests` row plus a `write_off_approval` work item for admins (priority 2, 24 h). The admin approves in the queue, which does the write-off as the admin with the biller recorded (`requestedBy` on the claim event and audit), or declines with a note; the biller gets a notification either way. The tenant's limit is `tenants.settings.writeOffApprovalLimitCents` (default $500) until S-04 exposes it.
- **Decision:** the write-off amount defaults to the denied amount, capped at the claim's balance. The claim balance from the 835 is patient responsibility plus anything denied, so writing off the whole balance would also write off what the patient owes on paid lines.
- **Decision:** D-02's "Corrected claim by" is the client's filing limit for the payer (`client_payer_settings.timely_filing_days`, default 90) counted from the denying payment's date. Payers state their own corrected-claim and appeal windows; this is a planning date, labelled with how it was worked out, until payer rules carry those windows.
- **Also:** D-03 bulk is admin-only and one client at a time (each client's PM has its own write-off codes); each denial's denied amount, one reason and code for all, each claim in its own transaction. The PM write-off codes offered are the client's adjustment mappings with action `write_off`, plus "Another code". A write-off chosen while a suggested correction existed is recorded as `suggestion: not_taken` in the audit; building the correction with the fix is recorded as `fixed` on `claim.correction_built`.
- **Docs:** `docs/09-ui-screens.md` does not say how an approval over the limit is stored or decided; this fills that gap and does not change any screen.

## DEC-17 — Claim status checks before production (Nov 2, 2026)

- **Decision:** one Stedi 276/277 client next to the eligibility client (`packages/eligibility`), switched the same way: Stedi with `STEDI_API_KEY`, else payer-sim in local and preview. Stedi's test keys do not cover claim status, so payer-sim answers the same path from what it received and decided.
- **Decision:** follow-ups (`no_response`) open from the daily sweep when a claim has no 277CA 7 days after it was sent or no payment 30 days after acceptance. The sweep checks claims with an open follow-up once a week; a person may check a claim once a day (C-15 "limited to one a day per claim"). A check that gets no answer within 15 seconds is queued again an hour later; the sweep's checks are not retried (the next sweep asks again), so a slow payer does not fill the dead-letter queue.
- **Decision:** the answer is stored as a `status_277` claim event (codes, amounts, dates; no names or member IDs). It may move a submitted claim to accepted (the payer has it) but never to paid or denied; the 835 decides money. The advice, the suggestion and the task (send records, resubmit) are rules in `packages/domain/src/claim-status`, not an LLM.
- **Decision:** the 276 sends the patient as the subscriber, as the eligibility check does. Dependents (a child on a parent's plan) need the subscriber's own name and birth date from the coverage; that comes with P-02 (edit coverage) in M4.
- **Also:** "usually pays in N days" (W-15) is the median days from acceptance to the payer's answer for the payer's claims answered in the last 180 days, shown from five claims up.

## DEC-18 — Demo time: one clock in local and preview (Nov 3, 2026)

- **Decision:** in local and preview, Cleanpost, the mock PM and the payer simulator share one date, so a demo can move weeks forward in minutes and the whole world follows: claims age, follow-ups come due, payments land on their dates, the work queue's due and overdue counts move. The payer simulator keeps the date (`/clock`); the admin's "+1, +7, +14 days" control (Work and Remittances, "Demo clock") moves it, sets Cleanpost's offset to match, runs the mock PM's clearinghouse, queues a sync per mock-PM practice and runs the daily follow-up sweep once (scheduled jobs run on the real clock, so days skipped at once would otherwise miss it).
- **Decision:** Cleanpost's offset lives in `app.clock` (one row). Business timestamps default to `app.now()` (now plus the offset); code reads business time from `@cleanpost/clock` `now()`, which every process refreshes from `app.clock` every 2 seconds (web per request, worker on a timer) and the browser gets from the page. Sign-in, sessions, rate limits, timeouts, job delays and log times stay on the real clock. The mock PM reads the simulator's clock every 5 seconds and before each clearinghouse run.
- **Decision:** two locks keep it out of staging and production. `app.clock.enabled` is false by default and only the system role can set it; the synthetic seed sets it in local and preview only (staging seeds keep it off). The app role may change only the offset, and the code refuses a non-zero offset, and reads a stored one as zero, when `CLEANPOST_ENV` is staging or production.
- **Also:** `pnpm test:cycle` now runs on demo time: Cleanpost and the PM move with the payer's 45 days and the daily sweep runs at each step. That surfaced two gaps, now closed: a release the PM refuses for good (a Tebra encounter still in Draft or sent back, which Cleanpost builds after the 2-hour quiet period) opens a manual task "Release the charge in {PM}" instead of only a log line; and a claim the PM never bills gets its no-acknowledgment follow-up after 7 days.

## DEC-19 — Demo history: 90 days replayed through the pipeline (Nov 3, 2026)

- **Decision:** the preview opens on a world that has been running for three months, built by the real pipeline, not inserted rows. `pnpm demo:reset` (local and preview) resets the payer simulator and the mock PM through their admin APIs, clears Cleanpost's activity and sets the demo clock (DEC-18) 90 days back, at 9 am Pacific; the worker then replays the 90 days (30 to 45 minutes): each weekday the practices enter 4 to 9 visits each in the mock PM; every three days (daily for the last two weeks) Cleanpost syncs, builds, checks eligibility and scrubs, simulated billers work the queue, the PM's clearinghouse sends and the payer answers, Tebra 835s are uploaded, and the daily follow-up sweep runs. The last step lands on today. The Demo clock bar shows how far it has got and refuses to move the clock meanwhile; a worker that restarts mid-replay carries on from the clock's date.
- **Decision:** the reset clears with the system role, as seeding does (CLAUDE.md rule 1), so it is a command, not a button: it runs in the preview's release step when no history was ever built (`--if-new`), and on request. Kept: tenants, clients, users with their passwords and two-factor, memberships, connections (their sync starts over), rules, mappings, payer settings, saved views. The audit log is append-only, so the earlier world's events stay in it with their dates. The replay itself runs as the app role.
- **Decision:** the simulated billers are the seeded users, so their work shows under their names (approvals, voids, write-offs, mappings, uploads) in the audit log, reports and timelines, as a demo needs; the data is synthetic and this exists only where demo time does. They do the routine work, deterministically by item and day: approve most claim reviews a day or more old, void most duplicates, write off a third of denials of $150 or less after three days, map each new adjustment code once (an admin, from the PM code posted for the same amount), upload Tebra 835s as they arrive. Fixes, corrected claims, posting differences, eligibility problems and follow-ups stay open as the backlog a team would have.

## DEC-20 — Reports computed on request; the practice PDF from the browser (Nov 3, 2026)

- **Decision:** RP-01 to RP-05 compute their figures on request from claims, claim events, 835s and work items for the clients in the user's scope (`packages/reports`, tested against direct computations), not from the hourly rollup tables the RP-01 design describes; the rollups come when volume needs them, with the same definitions. Reports hold totals only, so viewing one is not a PHI read; every export (CSV, PDF) is audit-logged as `report.exported` with the scope and format.
- **Decision:** the definitions (RP-07) live in `packages/domain/src/reports` and are the same words in the popover, the CSV comment lines and the PDF. A denial is what the 835 ingest counts as one (a CO or PI adjustment that is not contractual). First-pass acceptance is the first 277CA per claim; released without review is a first release with no approval before it; days in A/R is open insurance A/R over average daily charges for the last 90 days; aging counts calendar days from the first accepted submission (the release until the payer accepts). Payers with under 20 claims roll into "Other payers" on RP-02 and F-01.
- **Decision:** F-01 is a print-ready page (US Letter, 0.5 in margins, the billing company's name, Cleanpost only in the footer) saved as a PDF from the browser's print dialog, with the optional note typed on the page. No PDF engine runs on the server for now. No onboarding baseline is recorded yet, so RP-02 and F-01 say so instead of showing deltas; recording one comes with client onboarding (CL-, O-).
- **Decision:** charts are SVG on the design tokens with a table view each. The chart palette was checked for color-vision separation (`chart-1` to `chart-4` for series in fixed order, `chart-5` the neutral "Other", stacked next to `chart-1`): light `chart-2` moved to #00919C and the dark chart colors to darker steps (#6F87F5, #139FA9, #BE8220, #B072C8, #687482), the only token changes. Dark tokens now apply to screens only, so printed pages use the light theme.
- **Also:** payer-sim now denies about 2.5% of first-submission lines for reasons no scrub can see (CO-16, CO-50, CO-22, CO-96), so the denial reports and queues have the mix a payer gives; corrected claims are not denied this way.

## DEC-21 — Invites: join only with a second factor; links shown where email is off (Nov 4, 2026)

- **Decision:** an invite (S-02) is one row per address with the role and clients, a random 32-byte token sent once in the E-01 link and stored only as its SHA-256, valid 7 days. Resend makes a new token and 7 more days (the old link stops working); withdraw ends it. The unauthenticated A-06 page reads the invite through `app.invitation_by_token` (a security-definer function that takes only a 64-character hash and returns the company, inviter, role, client count and status), so no tenant data is readable without the token.
- **Decision:** joining needs a full sign-in as the invited address, two-factor included. A new person enters their name and password on A-06; that creates their sign-in only, and they go straight to A-03, then back to the invite to join. Someone with a Cleanpost account signs in (A-01 and A-02 carry `?next=`, same-site paths only) and joins. So no membership ever exists without a second factor, which is how A-06's rule "the account is created only after two-factor is set up" is met: the login record exists first because better-auth enrolls TOTP for a signed-in user. Until they join, S-01 shows the invite as pending.
- **Decision:** where email is off (`SMTP_HOST=log`, the preview), S-02 and Resend show the admin the invite link to pass on, so invites can be demonstrated. Only in local and preview (`inviteLinksShown`, packages/config); staging and production send the link by email only, which is how an invite proves the person owns the address. CI runs with email off too, which the e2e uses. A failed send keeps the invite (Resend tries again) and logs only the error code.
- **Also:** an address that is already a member, or already has a live invite, is refused inline; a member of another company can be invited (A-07 lets them switch).

## Open questions

| Question | Owner | Needed by |
| --- | --- | --- |
| Tebra test access (design partner test practice, or Tebra developer account) | Julia, James | Before M6, ideally during M1 |
| Does the partner's Tebra workflow send encounters through Review? Can billers download raw 835 files from Tebra? One billing-company account or one per practice? | Julia with the design partner | Before M6 |
| Do NCCI edit tables and rule code groups (CPT code numbers, no descriptions) need an AMA license? Until answered, CMS files are downloaded at deploy time, not committed, and no CPT descriptions are shown. | James | Before production |
| Transactional email provider for production (proposal: Amazon SES under the AWS BAA; emails carry no PHI by design) | James | M5 |
| Billing provider for invoices (S-11, E-07) | James | M7 |
