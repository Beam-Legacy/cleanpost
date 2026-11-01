# 01 — Architecture

## Repository layout

```
cleanpost/
  apps/
    web/            Next.js app: tenant UI, platform operator console, API routes, webhooks
    worker/         pg-boss job runner: syncs, scrubbing, submission, tracking, posting, reports
    pm-mock/        Reference PM system (own Postgres schema, REST API, simple UI for testing)
    payer-sim/      Payer simulator: accepts 837 JSON, returns 277CA and 835 on a schedule
  packages/
    domain/         Pure business logic: claim builder, rules, matching, state machines, money
    db/             Drizzle schema, migrations, RLS policies, tenant-scoped client
    adapters/       Adapter contract, registry, and one folder per PM adapter
    stedi/          Typed Stedi client (eligibility, claims, status, ERA, enrollment, webhooks)
    x12/            837/835/277 parsers and serializers for file-based adapters and golden tests
    ai/             Bedrock client, prompt templates, structured-output schemas, redaction guard
    ui/             Shared components built on shadcn/ui with Cleanpost tokens
    log/            pino logger with PHI redaction
    config/         Env schema (Zod), feature flags
    testing/        Synthetic data generators, fixtures, contract test suite
  docs/
  CLAUDE.md
```

## Runtime components

```
Browser ── Next.js (web) ──┬── Postgres (RLS, per-tenant rows)
                           ├── Object storage (documents, raw X12, encrypted)
Stedi webhooks ──► /api/webhooks/stedi ── enqueue job
                           │
                     worker (pg-boss)
                       ├── integration hub ── adapters ── PM systems (API / files / browser / manual)
                       ├── eligibility ── Stedi
                       ├── scrub + AI ── Bedrock
                       ├── submission ── Stedi (B, C) or adapter (A)
                       ├── tracking ── Stedi 276/277
                       ├── remittance + posting ── adapters
                       └── reports + metering
```

## Jobs

All asynchronous work is a pg-boss job. Payloads carry IDs only.

| Job | Trigger | Does |
| --- | --- | --- |
| `sync.pull` | Schedule per connection (default every 15 min), manual | Calls adapter pull operations, upserts canonical records, records a SyncRun |
| `eligibility.check` | New or changed coverage; 3 days before a scheduled claim release | Stedi 270, stores 271 summary |
| `claim.build` | New charges complete for an encounter | Builds claim version from canonical records |
| `claim.scrub` | After build, after any edit | Runs rules and AI review, sets confidence, routes |
| `claim.release` | Auto-release or approval | Mode A: adapter release; B/C: Stedi submission |
| `claim.ack` | Stedi webhook (999/277CA), PM sync | Applies acknowledgment events |
| `claim.statusSweep` | Daily | 276 for claims with no response after N days |
| `remit.ingest` | Stedi webhook (B), PM sync (A, C), file upload | Stores raw 835, parses, creates Remittance |
| `remit.match` | After ingest | Matches claims and lines |
| `remit.post` | After match | Mode B: post via adapter. A/C: verify the PM posted it; create exceptions |
| `remit.reconcile` | After post; daily | Checks posted totals against remittance and deposit |
| `denial.triage` | Denied lines found | Categorizes, suggests fix, creates work item |
| `timelyFiling.watch` | Daily | Flags claims nearing the payer's filing limit |
| `reports.rollup` | Hourly | Materializes report tables |
| `usage.meter` | Daily | Writes usage records for invoicing |

Retry policy: exponential backoff, max 5 attempts; after that the job creates a `system` work item and alerts the platform operator. Every job is idempotent, keyed by (job type, record ID, version).

## Environments

| Env | Data | Host | BAA |
| --- | --- | --- | --- |
| local | Synthetic only | Docker | n/a |
| preview | Synthetic only | Any low-cost host | Not required |
| staging | Synthetic plus de-identified golden files | AWS | Yes |
| production | Real PHI | AWS (ECS Fargate, RDS Postgres, S3 with SSE-KMS, Secrets Manager) | Yes, signed before any PHI |

## Key choices and why

- **Postgres for jobs and state** keeps one system to secure, back up and audit. Move long-running workflows to Temporal only if needed.
- **Adapters behind one contract** so new PMs never touch core logic.
- **Mock PM and payer simulator from day one** so the full cycle runs end to end without any real integration.
- **Stedi JSON APIs** avoid writing X12 for transport; the `x12` package exists for file-based PMs and golden-file tests.
