# Cleanpost — instructions for Claude Code

Cleanpost (working name) is multi-tenant software that medical billing companies use to run their clients' claims from charge to posted payment. It is a platform, not a billing service: the billing company owns the work and the outcome; Cleanpost automates it.

Read `docs/00-overview.md` first, then the doc for the area you are working on. The docs are the source of truth. If code and docs disagree, stop and ask; do not silently pick one.

## Non-negotiable rules

1. **Tenant isolation.** Every table holding customer data has `tenant_id`. Every query runs inside a transaction that sets `app.tenant_id`; Postgres row-level security enforces it. Never bypass RLS outside the `system` role used by migrations and the platform admin service.
2. **No PHI outside the database and encrypted object storage.** No PHI in logs, error messages, analytics, job payloads, URLs, query strings, filenames, commit messages, test snapshots, or LLM prompt logs. Job payloads carry record IDs only. Use `@cleanpost/log` (pino with redaction); never `console.log`.
3. **PMs are reached only through the adapter contract** (`packages/adapters`). Core code never imports a PM-specific module.
4. **Claims are versioned, never edited after submission.** A correction or resubmission creates a new `claim_version` linked to the original with the correct frequency code (1, 7, 8).
5. **Money is integer cents** (`bigint`). Never floats. Every remittance must reconcile to the cent before it is marked posted.
6. **Every state change goes through the state machines** in `packages/domain/state`. No direct `UPDATE ... SET status`.
7. **Every PHI read and write is audit-logged** through `withAudit()`.
8. **Automation is reversible or gated.** Anything that sends data to a payer or writes to a PM is either above the client's configured confidence threshold or approved by a human, and is recorded with the actor (`user:<id>` or `automation:<rule>`).
9. **LLMs explain and suggest; deterministic code decides.** The LLM never sets a code, amount or status directly. See `docs/06-rules-and-ai.md`.
10. **Use synthetic data only** until the production environment under a BAA exists. Never paste real patient data into prompts, fixtures or tickets.
11. **CPT descriptions are not displayed** until the AMA license is in place. Show codes only.

## Stack

- TypeScript (strict), Node 22, pnpm workspaces + Turborepo
- `apps/web`: Next.js (App Router), React Server Components, Tailwind, shadcn/ui (Radix), TanStack Table, React Hook Form + Zod
- `apps/worker`: job runner (pg-boss on Postgres)
- `apps/pm-mock`: reference PM system (fake practice management app with its own DB and API)
- `apps/payer-sim`: payer simulator that adjudicates test claims and emits 277CA and 835
- Postgres 16, Drizzle ORM and migrations
- Auth: better-auth (self-hosted) with TOTP and WebAuthn MFA
- Stedi healthcare APIs (sandbox until production)
- Claude via AWS Bedrock (`@cleanpost/ai`) — anonymous dev key only against synthetic data
- Playwright (e2e tests and browser-automation adapters), Vitest (unit/integration)

## Commands

```
pnpm i
pnpm db:up            # local Postgres via docker compose
pnpm db:migrate
pnpm seed             # synthetic tenants, clients, patients, charges (docs/12-testing.md)
pnpm dev              # web + worker + pm-mock + payer-sim
pnpm test             # unit + integration
pnpm test:e2e         # Playwright
pnpm test:adapters    # adapter contract suite against every registered adapter
pnpm lint && pnpm typecheck
```

## Conventions

- Domain logic lives in `packages/domain` as pure functions with unit tests. Route handlers and jobs are thin.
- Validate every external input with Zod at the boundary (API, webhook, adapter, file import).
- IDs: UUIDv7. Timestamps: `timestamptz`, UTC. Dates of service: `date`.
- Errors: typed `Result` objects in domain code; throw only at boundaries.
- UI follows the designs in `ui/` (see `ui/README.md`) and `docs/10-design-system.md`. Use design tokens from `ui/assets/tokens.css`, never raw hex values. Reference the view ID (e.g. W-01) in commits.
- Every feature PR includes tests and updates the relevant doc.
- Commit in small steps that each pass `pnpm test`.

## Build order

Follow `docs/16-milestones.md`. Do not start a milestone until the previous milestone's acceptance criteria pass.
