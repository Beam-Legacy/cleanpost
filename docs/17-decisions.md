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

## Open questions

| Question | Owner | Needed by |
| --- | --- | --- |
| Tebra test access (design partner test practice, or Tebra developer account) | Julia, James | Before M6, ideally during M1 |
| Does the partner's Tebra workflow send encounters through Review? Can billers download raw 835 files from Tebra? One billing-company account or one per practice? | Julia with the design partner | Before M6 |
| Do NCCI edit tables and rule code groups (CPT code numbers, no descriptions) need an AMA license? Until answered, CMS files are downloaded at deploy time, not committed, and no CPT descriptions are shown. | James | Before production |
| Transactional email provider for production (proposal: Amazon SES under the AWS BAA; emails carry no PHI by design) | James | M5 |
| Billing provider for invoices (S-11, E-07) | James | M7 |
