# 01 — Architecture

## Repository layout

```
cleanpost/
  apps/
    web/            Next.js app: tenant UI, platform operator console, API routes, webhooks
    worker/         pg-boss job runner: syncs, scrubbing, submission, tracking, posting, reports
    pm-mock/        Reference PM system (own Postgres schema, REST API, simple UI for testing)
    payer-sim/      Payer simulator: accepts 837 JSON, returns 277CA and 835 on a schedule
    website/        Static marketing site built from the WEB- designs (no PHI, no app code; off the pilot path)
  packages/
    domain/         Pure business logic: claim builder, rules, matching, state machines, money
    db/             Drizzle schema, migrations, RLS policies, tenant-scoped client
    adapters/       Adapter contract, registry, and one folder per PM adapter
    sync/           Sync engine: pulls into canonical tables, connection state, shared rate limiter
    jobs/           Job queue (pg-boss): queue names, ID-only payload schemas, install
    stedi/          Typed Stedi client (eligibility, claims, status, ERA, enrollment, webhooks)
    x12/            837/835/277 parsers and serializers for file-based adapters and golden tests
    ai/             Bedrock client, prompt templates, structured-output schemas, redaction guard
    email/          Transactional email templates (E-01 to E-07) and sender; emails never contain PHI
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

All asynchronous work is a pg-boss job. Payloads carry IDs only and are validated with Zod when read (`packages/jobs`). The queue lives in its own `pgboss` schema: `pnpm db:migrate` installs it as the migration role and grants it to the app role; the web app only sends jobs, the worker also runs the schedule and maintenance.

| Job | Trigger | Does |
| --- | --- | --- |
| `sync.tick` | Every minute (worker) | Lists due connections through `app.sync_candidates()` (IDs and schedule fields only) and queues `sync.pull` for each; marks healthy connections stale after 2× their interval |
| `sync.pull` | `sync.tick` (default interval from the adapter's `syncPolicy`: mock 15 min, Tebra 2 hours; connections may override), Run now on I-02 | Calls adapter pull operations, upserts canonical records, records a SyncRun per operation, moves the connection through its state machine. One queued and one running job per connection. M1 pulls patients and charges; claim status joins in M2, remittances and postings in M3 |
| `system.dead_letter` | A job that failed its last retry | Creates a `system` work item and logs an error for the platform operator |
| `eligibility.check` | A built claim whose coverage has no check in the last 7 days (the scrub waits for it); later also 3 days before a scheduled release | Stedi 270 (payer-sim in local and preview), stores the 271 summary; then queues the waiting scrubs. A payer that is down is retried, then the scrub goes on without a check |
| `claim.build` | New charges complete for an encounter | Builds claim version from canonical records |
| `claim.scrub` | After build, after any edit | Runs rules and AI review, sets confidence, routes |
| `claim.release` | Auto-release, or approval (queued 10 s out so Undo can cancel it) | Mode A: adapter release; B/C: Stedi submission. Waits while a correction is on its way to the PM |
| `claim.correct` | A person's edit of a Mode A claim | Writes every change the PM does not have yet with `pushChargeCorrection`, or opens one correction task with a worksheet |
| `claim.ack` | Stedi webhook (999/277CA), PM sync | Applies acknowledgment events |
| `claim.statusSweep` | Daily, 6:17 am Pacific | Opens a follow-up (`no_response`) for a claim with no 277CA 7 days after it was sent, or no payment 30 days after acceptance; queues `claim.statusCheck` for open follow-ups not checked for a week; closes follow-ups on claims that moved on |
| `claim.statusCheck` | The sweep; an hour after a person's check got no answer | A 276 through Stedi (payer-sim in local and preview): a `status_277` claim event; a submitted claim the payer has becomes accepted. A payer that does not answer is asked again at the next sweep (no retries) |
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
| local | Synthetic only | Docker (Postgres, Mailpit for email) | n/a |
| preview | Synthetic only | Railway project `cleanpost-preview`, all with `CLEANPOST_ENV=preview`: Postgres 16; `web` (Dockerfile `apps/web/Dockerfile`, pre-deploy `pnpm release:preview` which also seeds the mock PM, health check `/api/health`, `SMTP_HOST=log`, so S-02 shows invite links instead of emailing them, DEC-21); `worker` (`apps/worker/Dockerfile`, `/health`); `pm-mock` (`apps/pm-mock/Dockerfile`, reached by the worker at `pm-mock.railway.internal:4010`, admin page behind basic auth; its clearinghouse sends queued claims to payer-sim every minute); `payer-sim` (`apps/payer-sim/Dockerfile`, `payer-sim.railway.internal:4030`, own `payer_sim` schema) | Not required |
| staging | Synthetic plus de-identified golden files | AWS | Yes |
| production | Real PHI | AWS (ECS Fargate, RDS Postgres, S3 with SSE-KMS, Secrets Manager) | Yes, signed before any PHI |

## Key choices and why

- **Postgres for jobs and state** keeps one system to secure, back up and audit. Move long-running workflows to Temporal only if needed.
- **Adapters behind one contract** so new PMs never touch core logic.
- **Mock PM and payer simulator from day one** so the full cycle runs end to end without any real integration.
- **Stedi JSON APIs** avoid writing X12 for transport; the `x12` package exists for file-based PMs and golden-file tests.
