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
  capabilities(conn: Connection): Promise<CapabilityMap>;   // operation -> level
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
| `tebra` | Stub with real types; implement first after mock | Official SOAP API covers charges, encounters, payments and transactions, and can create encounters and payments. Access via a customer key the practice admin generates. |
| `athenaone` | Stub | Official REST API (claims, ERAs, payments) behind Marketplace partner approval, security review and per-call fees for proprietary APIs. athena may post remits itself; Mode A verify-only fits well. |
| `advancedmd` | Stub | Vendor lists an API; access terms to confirm. Managed third-party API exists. |
| `modmed` | Stub | Partner-gated write API. |
| `simplepractice` | Stub | No official public API; managed API or browser automation. |
| `eclinicalworks`, `drchrono`, `collaboratemd`, `officeally`, `nextgen_office` | Stub (manual + file only) | Research when a design partner needs one. |

A stub adapter: real `capabilities()` returning level 0 for everything, `map.ts` types drafted from public docs, and a README listing access steps, costs and open questions. Stubs pass the contract suite by producing correct manual tasks.

## Reference PM mock (`apps/pm-mock`)

A small practice management system with its own schema: practices, providers, patients, policies, appointments, encounters, charges, claims, payments, adjustments, adjustment codes. It exposes:
- REST API matching every adapter operation, with optional faults (latency, 500s, auth expiry, partial pages) toggled by headers for testing.
- Its own "clearinghouse" mode: if a client is in Mode A, released charges are sent to `apps/payer-sim`, and 835s come back into pm-mock, which auto-posts them (with a configurable error rate, e.g. 5% of lines posted to the wrong adjustment code) so Cleanpost's verification has something to catch.
- A minimal admin UI so a human can see what Cleanpost wrote into the PM.

## Contract test suite (`pnpm test:adapters`)

Runs against every registered adapter: capabilities are declared for every operation; pulls are idempotent and paginate; unsupported operations return manual tasks; mapping produces valid canonical records (Zod); errors are typed and contain no PHI.

## Credentials

Stored in AWS Secrets Manager (local: encrypted file). `connections.credentials_secret_ref` holds only the reference. Billing companies create a dedicated least-privilege PM user per client for Cleanpost. Rotation reminder every 90 days.
