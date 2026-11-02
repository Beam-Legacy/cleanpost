# 05 — PM adapters

Every PM connection is an adapter implementing one contract (`packages/adapters/src/contract.ts`). Core code calls the contract through the registry; it never knows which PM it is talking to.

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
- Each adapter's `map.ts` turns the PM's own payloads into `Ext*` records, unit-tested with fixtures (recorded ones once a live account exists). `packages/adapters/src/schemas.ts` validates every `Ext*` record at the boundary (Zod); sync then maps `Ext*` to canonical rows in one shared place.

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
| `pullPostings` | `GetCharges`: per charge line and insurance order, allowed, payment, contractual adjustment with reason, other adjustment with reason, deductible, coinsurance, copay, payment reference and posting date (from the WSDL schema, Nov 1, 2026) | 4 | Line-level posting match looks possible; confirm what the adjustment reason holds (CARC or Tebra text) in the Tebra test |
| `postPayment` | `CreatePayment` makes a payment header only | 0 | Posting worksheet (only relevant in Mode B) |

## Sync policy and rate limits

Each adapter declares a `syncPolicy` (contract): the default `sync.pull` interval and whether large pulls should run outside business hours. A connection can override the interval. PM rate limits apply per PM account, not per connection: connections that share a PM account (for example several practices in one Tebra billing-company account) share `connections.pm_account_ref`, one credential and one rate limiter. Adapters wait on a Postgres-backed limiter provided by the registry, keyed by `pm_account_ref` and PM endpoint, so every worker respects the same limit. A rate-limit response becomes `RATE_LIMITED` (retryable).

Tebra: every 2 hours by default, backfills after hours, limits from `docs/15-integrations-reference.md`.

How it is built (`packages/sync`, M1):
- The limiter is a token bucket per (tenant, PM account or connection, endpoint) in `rate_limit_buckets`; each take is a short tenant transaction, so every worker process shares it. A wait longer than 30 seconds becomes `RATE_LIMITED`.
- A cycle asks the adapter for its capabilities (saved to `connections.levels`), then runs each automatic pull (level 1, 2 or 4; file pulls run on upload). Each page is written in its own tenant transaction; HTTP calls never run inside one.
- Records are matched through `external_refs` (connection, entity type, PM ID), so a repeat pull changes nothing. A record that fails validation is counted as failed and named in the sync run by PM ID and field only.
- `since` is the start of the last succeeded run minus 10 minutes. The first patients pull reads everything; the first charges pull reaches back 120 days.
- Retryable errors (5xx, partial pages, timeouts, 429) are retried within the run. After that the outcome goes through the connection state machine: authentication failure → `failed` at once; an operation failing → `degraded`; three cycles in a row in which everything failed → `failed`; success → `healthy`. A degraded or failed connection has one open `sync_failure` work item, resolved by automation when it recovers.
- Pause and Resume (I-02) and staleness (no success for 2× the interval) use the same state machine.

## Reference PM mock (`apps/pm-mock`)

A small practice management system with its own schema (`pm_mock`): accounts, practices, providers, locations, patients, policies, encounters, charges, claims, payments, postings, remittances, adjustment codes, a write log and the generator's answer key. Cleanpost never reads these tables, only the API. Each PM account (one API key, one rate limit, possibly several practices) runs a capability profile:
- `generic`: every operation supported.
- `tebra`: Draft/Review/Approved/Rejected encounter workflow (hold = stay in Review, release = Approved); no mark billed, no corrections, no remittance files; payments created as headers only; Tebra's per-account, per-endpoint limits.
- `managed_api`: no hold or corrections; full payment posting.

It exposes:
- A REST API (`/api/v1/practices/:id/...`) matching every adapter operation. Lists page by `(updated_at, id)` from `since`. Faults can be injected per request with `X-Mock-Fault` (`auth_expired`, `error_500`, `partial_page`, `rate_limited`, `timeout`, `latency:<ms>`) or stored on the account for a number of requests or minutes.
- Its own "clearinghouse" mode (M2): if a client is in Mode A, released charges are sent to `apps/payer-sim`, and 835s come back into pm-mock, which auto-posts them (with a configurable error rate, e.g. 5% of lines posted to the wrong adjustment code) so Cleanpost's verification has something to catch.
- A minimal admin page (`/admin`, basic auth with `PM_MOCK_ADMIN_PASSWORD`). It shows what Cleanpost wrote into the PM, injects account faults and adds today's visits, so a demo can show new charges arriving.

Account API keys in local and preview are derived from `PM_MOCK_SECRET`; connections reference them as `pm-mock:<account>` and the development secret resolver turns that into the key. The mock adapter and pm-mock refuse to run in staging and production.

## Contract test suite (`pnpm test:adapters`)

Runs against every registered adapter: capabilities are declared for every operation (only `holdCharge`, `releaseCharge` and `markChargeBilled` may be `unavailable`); pulls are idempotent and paginate; unsupported operations return manual tasks; mapping produces valid canonical records (Zod); errors are typed and contain no PHI. The mock adapter runs it against an in-process pm-mock for each profile (`apps/pm-mock/test/contract.test.ts`), plus fault mapping and shared rate limits.

## Credentials

Stored in AWS Secrets Manager (local: encrypted file). `connections.credentials_secret_ref` holds only the reference. Billing companies create a dedicated PM user for Cleanpost with the least privilege the PM allows. Some PMs require more: Tebra's API user must be a System Admin. Each adapter README records such gaps, and the onboarding copy (O-04) states them. Connections that share a PM account share one credential. Rotation reminder every 90 days.
