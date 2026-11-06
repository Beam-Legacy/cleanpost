# 18 — Demo script

A 30 to 40 minute walk-through of Cleanpost on the preview environment for a billing company owner. Everything shown is synthetic (CLAUDE.md rule 10): the practices, patients, payers' answers and 835s come from the mock PM (`apps/pm-mock`) and the payer simulator (`apps/payer-sim`). The demo tools described here exist only in local and preview (`simConfig()`); the real product has none of them.

Preview web app: `https://web-preview-d084.up.railway.app`. Locally: `pnpm dev` after `pnpm db:up`, `pnpm db:migrate` and `pnpm seed` (docs/12-testing.md).

## Accounts

All seeded accounts share the seed password (`SEED_PASSWORD` in the preview environment's variables on Railway; locally, the value in `.env`). On preview, two-factor setup offers "Skip for now" (`PREVIEW_ALLOW_SKIP_2FA`); the real product has no way past that step.

| Account | Company | Role | Use it for |
| --- | --- | --- | --- |
| julia@northwind.test | Northwind Billing (owner), also Harbor RCM | Admin | The main demo: everything, including settings and approvals |
| priya@northwind.test | Northwind Billing | Admin | Approving a write-off a biller requested |
| dana@northwind.test | Northwind Billing | Biller, 4 clients | What a biller sees: only their clients, no settings |
| hana@harbor-rcm.test | Harbor RCM | Biller | Tenant isolation: none of Northwind is visible |

## Before the demo (10 minutes, the day before or an hour before)

1. **Start fresh if the world is stale.** `pnpm demo:reset` (needs the system database role, so it runs from a terminal, not the app) wipes the demo world and replays 90 days of history through the real pipeline with simulated billers (DEC-19). On preview it takes a while; the Demo clock bar on Work shows the replay's progress ("Building 90 days of demo history: day N of 90"). Wait until the bar shows today's date with no progress line. Skip this step if the world was reset recently and looks right.
2. **Push the demo clock forward.** Sign in as Julia, open Work (W-01). The Demo clock bar at the top shows the simulated date. Press **+7 days** (or +1, +14). This moves the payer simulator, the mock PM and Cleanpost together (DEC-18): the clearinghouse runs, payers adjudicate and pay, 835s land in the PM, every mock connection syncs, and the daily follow-up sweep runs. Do it once or twice so the queue has fresh rejections, denials, posting differences, follow-ups and claims close to their filing limits. Each press takes 20 to 60 seconds; the bar says when it is done.
3. **Break a PM connection so the bell has something to say.** Open Integrations (I-01), pick any Northwind connection to the mock PM, and on its page (I-02) press **Expire the login (demo)** in the mock PM banner. The mock PM starts refusing that practice's login; the sync it starts fails at once with an authentication error, which opens a `sync_failure` item in the queue and, within a few seconds, a "connection failed" notification for every admin (in-app, and an urgent email where the admin's settings allow it). The I-02 page refreshes after about six seconds and shows the connection as failed. The bell polls every minute; refresh the page to see the count at once. You can also do this live, during step 9 of the walk-through, for effect.
4. **Check the pages you will show load with data:** Work, a claim, Remittances, Denials, Reports, Settings → Usage.

## Walk-through

Signed in as Julia unless noted. The talk track is a suggestion; the clicks are what matters.

1. **The biller's day: Work (W-01).** "This is what a biller opens in the morning. Everything that needs a person, and nothing that doesn't." Point out the summary strip (due today, ready to release, released today, payments posted, automation rate) and the type chips (Review, Rejections, Denials, Posting, Eligibility, Manual tasks). The empty-state line, when a filter is empty, says how many claims went out without anyone touching them.
2. **Claim review (W-10).** Select a Review item. The side panel shows the claim compactly, the scrub findings with the rule behind each, and "Why is this here?". Press **Approve and release** (or `A`). The toast offers **Undo** for 10 seconds (DEC-13): release is gated and reversible. Open the claim (C-02) to show the timeline, the versions and the AI summary labeled "Suggested summary" (the LLM explains; deterministic code decides).
3. **Eligibility issue and the insurance card (W-13, P-04, P-05).** Filter Eligibility and select an item. The panel shows each coverage with the payer's latest answer and the AAA reason. Press **Upload card photo**, then **Use a sample card (demo)**: Cleanpost draws a synthetic photo of the patient's card from the mock PM's data, the worker reads it, and P-05 shows the reading next to the image with the low-confidence field (the group number, 84%) marked and focused. Confirm it: the coverage updates in Cleanpost, the claim is re-scrubbed and a task asks the biller to make the same change in the PM; the claim is released after the next sync shows the PM caught up (DEC-30, DEC-31). If you close P-05 without confirming, the card waits in the queue as W-14.
4. **Patient corrections (P-01, P-02, P-06).** Open the patient. Member IDs and date of birth are masked until revealed, and revealing is audited. Show **Update coverage** and **Edit patient**: each correction says up front that it needs the PM and leaves one task per patient.
5. **Denials and the corrected claim (W-16, D-01, D-02, Flow 5).** Filter Denials and select a CO-4 denial (modifier inconsistent with procedure). The panel explains the code in plain language and suggests the fix (labeled "Suggested"). Press **Build correction**: a new claim version with frequency code 7 and the payer's claim number, the fix applied, scrubbed again. Then open Denials (D-01) for the view by category with the balance at risk, and a row for the D-02 drawer: similar denials from the same payer, the correction deadline.
6. **Write-off approval (D-03).** From a denial, **Write off** an amount over the company's approval limit as Dana (biller): she can only request it. Sign in as Priya (or switch back to Julia) and approve it from the queue. Every step records who did it.
7. **Remittances (R-01, R-04).** Open Remittances. Each 835 the payer sent, checked line by line against what the PM auto-posted, reconciled to the cent. Open one with differences (R-04): a line the PM skipped, a line posted with the wrong adjustment code. Each difference is one item in the queue; nothing posts that does not balance.
8. **Timely filing (W-22).** Filter for a timely filing item (pushing the clock forward makes more). The panel shows the days left in red within 3 days, where the limit comes from (the client's payer setting or the 90-day default), what is holding the claim with a link to fix it, and the ways out: **Release now**, upload proof of timely filing, **Escalate to admin**. It cannot be snoozed past the deadline. The claim page (C-02) shows the same deadline in its banner.
9. **The notification bell (G-04).** If you broke a connection before the demo, the bell shows the unread count: open it for "connection failed" (and any timely filing, out-of-balance or overdue alerts the clock produced). If not, do it now: Integrations → a mock connection → **Expire the login (demo)**, wait a few seconds, refresh. Click the notification to land on I-02, where the connection shows failed with the error, and the `sync_failure` item is in the queue. Settings → Notifications (S-09) shows each person choosing in-app, email and digest per alert, with quiet hours.
10. **Search (G-03).** Press `⌘K` (`Ctrl+K`): a patient's last name, a claim's control number, an 835 trace number, a client. Type `>` for commands. Results stay within the person's clients and role; every search is audited without storing what was typed.
11. **Reports (RP-01 to RP-06).** Reports opens on the overview: collections, first-pass acceptance, denial rate, days in A/R and released without review, each against the period before, from 90 days of history. Show a client report (RP-02), A/R aging, Definitions (RP-07: every figure explained with the report's own numbers) and a CSV export.
12. **A new client (O-01 to O-11, Flow 1).** Clients → **Add client**. Walk the wizard: practice details, the PM (the mock PM makes a practice and tests the connection), a 7-day dry run with a spot check, payer matching with timely filing, Mode A recommended because the PM can hold charges, mappings, "review everything for two weeks", the go-live checklist and Go live. The first sync runs in front of you (O-11). Then the client overview (CL-02) against the onboarding baseline.
13. **Settings.** Users and roles (S-01, invite on S-02), Automation (S-04: the threshold with a live simulation of the last 30 days), Rules (S-05, S-06), Notifications (S-09), Usage (S-11: claims released through Cleanpost by client and mode, today counted live), Audit log (S-13: every PHI read and write, in plain language).
14. **Optional: what a biller sees.** Sign in as Dana: only her four clients in the queue, search and reports, no settings and no team report. Sign in as Hana (Harbor RCM): none of Northwind exists for her.

## After the demo

- **Fix the login (demo)** on the I-02 page of the connection you broke. The next sync succeeds, the connection goes back to healthy and its `sync_failure` item resolves itself.
- The demo clock stays where you left it. Pushing it further is fine; to start over, run `pnpm demo:reset` again.
- A "Reset demo" button in the app would need the system database role from the web app, which the app never has (CLAUDE.md rule 1), so reset stays a terminal command.

## If something goes wrong

- **The Demo clock bar says the history stopped before today.** Run `pnpm demo:reset` again.
- **The bell shows nothing after breaking a connection.** Refresh the page (the bell polls every 60 seconds). Check the connection on I-02 shows failed; if it does not, the worker may be down (Railway preview: the worker service's logs).
- **A clock press does nothing.** The payer simulator or the mock PM may be asleep or redeploying; wait a minute and press again.
- **Card reading never finishes.** The worker reads cards; check it is running. In preview the stand-in reader only reads Cleanpost's synthetic sample cards; a real photo is refused on purpose.
