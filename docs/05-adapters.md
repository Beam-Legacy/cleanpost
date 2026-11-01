# 05 — PM adapters

Every PM connection is an adapter implementing one contract (`packages/adapters/src/contract.ts`, starter copy in `starter/`). Core code calls the contract through the registry; it never knows which PM it is talking to.

## Integration levels

Each operation an adapter supports declares a level. The UI shows it, and the platform picks the highest working level.

| Level | Method | Notes |
| --- | --- | --- |
| 4 | Official API | Most stable. Often partner-gated. |
| 3 | File exchange | SFTP or scheduled CSV/X12 export and import. |
| 2 | Managed third-party API | Vendor-maintained unofficial APIs. Requires BAA and a terms review per PM. |
| 1 | Browser automation | Playwright worker using a dedicated PM user. Brittle; monitored by the health check. |
| 0 | Manual | Cleanpost creates a pre-filled task; a biller does it in the PM and confirms. |
| — | Not available (`unavailable`) | The PM has no equivalent and a manual task would not help. Allowed only for `holdCharge`, `releaseCharge` and `markChargeBilled`. The platform uses the fallback in `docs/04-modes.md` instead: scrub before the PM's batch (`clients.pm_batch_time`) or require the PM's electronic submission to be turned off. Shown as "Not available in this PM" (I-02, O-03). |

**Every operation of every adapter falls back to level 0**, except operations declared `unavailable`. A client can go live on day one with no integration at all; the manual adapter carries it until a real one is built. This is how the MVP ships without live connectors.

## Contract (summary)

```ts
interface PmAdapter {
  key: AdapterKey;                       // 'mock' | 'manual' | 'file' | 'tebra' | ...
  syncPolicy: SyncPolicy;                // default pull interval, off-hours preference
  capabilities(conn: Connection): Promise<CapabilityMap>;   // operation -> level 0-4 or 'unavailable'
  healthCheck(conn): Promise<HealthResult>;

  pullPatientsAndCoverage(conn, since: Date): Promise<Page<ExtPatient>>;
  pullCharges(conn, since: Date): Promise<Page<ExtEncounter>>;   // encounters with lines and dx
  pullClaimsAndStatus(conn, since: Date): Promise<Page<ExtClaimStatus>>;
  pullRemittances(conn, since: Date): Promise<Page<ExtRemittance>>;  // 835-equivalent
  pullPostings(conn, since: Date): Promise<Page<ExtPosting>>;        // what the PM posted

  holdCharge(conn, encounterExtId): Promise<OpResult>;
  releaseCharge(conn, encounterExtId): Promise<OpResult>;
  markChargeBilled(conn, encounterExtId, claimRef): Promise<OpResult>;
  pushChargeCorrection(conn, correction: ChargeCorrection): Promise<OpResult>;
  postPayment(conn, posting: PostingInstruction): Promise<OpResult>;
}
```

- Every operation returns `OpResult = { ok: true, externalRef? } | { ok: false, retryable: boolean, code: AdapterErrorCode, manualTask?: ManualTaskSpec }`.
- Unsupported operations return `{ ok: false, retryable: false, code: 'UNSUPPORTED', manualTask }` so the platform turns them into manual tasks automatically.
- Pull operations are cursor-paged and idempotent. Records carry the PM's external IDs; the hub maps them through `external_refs`.
- Mapping from `Ext*` types to canonical records lives in each adapter's `map.ts` and is unit-tested with recorded fixtures.

## Adapters to build now

| Adapter | MVP state | Purpose |
| --- | --- | --- |
| `mock` | Complete, all operations at level 4 | Talks to `apps/pm-mock`. Proves the whole cycle. Template for real adapters. |
| `manual` | Complete | Every operation produces a manual task: charge entry sheet, correction instructions, posting worksheet (per remit, grouped by claim and line, with adjustment codes already mapped to the PM's codes). |
| `file` | Complete | Imports charge CSV (template in `docs/15-integrations-reference.md`) and 835 files; exports posting files where a PM supports import. |
| `tebra` | Skeleton from the public WSDL in M1; built in M6 against a test practice | Official SOAP API 2.1: patients, charges, encounter details, payments, transactions; encounter status updates; payment headers. No ERAs. Expected capabilities below; details in `docs/15-integrations-reference.md`. |
| `athenaone` | Stub | Official REST API (claims, ERAs, payments) behind Marketplace partner approval, security review and per-call fees for proprietary APIs. athena may post remits itself; Mode A verify-only fits well. |
| `advancedmd` | Stub | Vendor lists an API; access terms to confirm. Managed third-party API exists. |
| `modmed` | Stub | Partner-gated write API. |
| `simplepractice` | Stub | No official public API; managed API or browser automation. |
| `eclinicalworks`, `drchrono`, `collaboratemd`, `officeally`, `nextgen_office` | Stub (manual + file only) | Research when a design partner needs one. |

A stub adapter: real `capabilities()` returning level 0 for everything, `map.ts` types drafted from public docs, and a README listing access steps, costs and open questions. Stubs pass the contract suite by producing correct manual tasks.

## Tebra: expected capabilities

From Tebra's API guide (April 2026) and its public WSDL. Confirm each row in the Tebra test (`docs/16-milestones.md`) and update this table with the result.

| Operation | Tebra call | Expected level | Notes |
| --- | --- | --- | --- |
| `pullPatientsAndCoverage` | `GetPatients`, `GetPatient` | 4 | Confirm where policy fields live (patient cases) |
| `pullCharges` | `GetCharges` with `IncludeUnapprovedCharges` and `EncounterStatus = Review`, then `GetEncounterDetails` | 4 | |
| `holdCharge` | None needed: an encounter waits in Review until it is approved | 4 if the practice sends encounters through Review; otherwise `unavailable` | Tebra's Rejected status means "needs clarification or corrections"; use it only if the test shows it fits the practice's workflow |
| `releaseCharge` | `UpdateEncounterStatus` → Approved | 4 (same condition) | Only encounters in Draft or Review can be updated. Tebra builds the claim and sends it in its next batch |
| `pushChargeCorrection` | None | 0 | Manual task: the biller fixes the encounter in Tebra, the next pull re-scrubs it, then Cleanpost releases it |
| `markChargeBilled` | None | `unavailable` | Modes B and C need Tebra's electronic claim submission turned off for the practice |
| `pullClaimsAndStatus` | `GetCharges` (status and billing dates) | 4, coarse | Statuses: Pending, Ready, Completed, Error – Rejection, Error – Denial, Error – No Response. Confirm what Tebra sends as CLM01 (`claims.pcn_source = pm`) |
| `pullRemittances` | None | 3 (835 file upload) | Tebra's API has no ERA access. Confirm billers can download raw 835 files |
| `pullPostings` | `GetPayments`, `GetTransactions`, charge balances from `GetCharges` | 4, partial | If adjustments carry no codes, the posting match compares amounts per line and flags codes as unavailable |
| `postPayment` | `CreatePayment` makes a payment header only | 0 | Posting worksheet (only relevant in Mode B) |

## Sync policy and rate limits

Each adapter declares a `syncPolicy` (contract): the default `sync.pull` interval and whether large pulls should run outside business hours. A connection can override the interval. PM rate limits apply per PM account, not per connection: connections that share a PM account (for example several practices in one Tebra billing-company account) share `connections.pm_account_ref`, one credential and one rate limiter. Adapters wait on a Postgres-backed limiter provided by the registry, keyed by `pm_account_ref` and PM endpoint, so every worker respects the same limit. A rate-limit response becomes `RATE_LIMITED` (retryable).

Tebra: every 2 hours by default, backfills after hours, limits from `docs/15-integrations-reference.md`.

## Reference PM mock (`apps/pm-mock`)

A small practice management system with its own schema: practices, providers, patients, policies, appointments, encounters, charges, claims, payments, adjustments, adjustment codes. It runs with a capability profile per practice: `generic` (every operation supported) and `tebra` (Draft/Review/Approved/Rejected encounter workflow, no ERA access, payment headers only, Tebra's per-account rate limits), so the full cycle is tested against a PM as limited as the first real one. It exposes:
- REST API matching every adapter operation, with optional faults (latency, 500s, auth expiry, partial pages) toggled by headers for testing.
- Its own "clearinghouse" mode: if a client is in Mode A, released charges are sent to `apps/payer-sim`, and 835s come back into pm-mock, which auto-posts them (with a configurable error rate, e.g. 5% of lines posted to the wrong adjustment code) so Cleanpost's verification has something to catch.
- A minimal admin UI so a human can see what Cleanpost wrote into the PM.

## Contract test suite (`pnpm test:adapters`)

Runs against every registered adapter: capabilities are declared for every operation; pulls are idempotent and paginate; unsupported operations return manual tasks; mapping produces valid canonical records (Zod); errors are typed and contain no PHI.

## Credentials

Stored in AWS Secrets Manager (local: encrypted file). `connections.credentials_secret_ref` holds only the reference. Billing companies create a dedicated PM user for Cleanpost with the least privilege the PM allows. Some PMs require more: Tebra's API user must be a System Admin. Each adapter README records such gaps, and the onboarding copy (O-04) states them. Connections that share a PM account share one credential. Rotation reminder every 90 days.
