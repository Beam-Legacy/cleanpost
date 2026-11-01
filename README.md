# Cleanpost build scope

Specification kit for building Cleanpost with Claude Code. Copy this folder into a new repository, then start Claude Code in it.

## What's here

- `CLAUDE.md` — rules and conventions Claude Code follows on every task
- `docs/` — the full specification (start with `docs/00-overview.md`)
- `starter/packages/adapters/src/contract.ts` — the adapter contract as TypeScript, to move into `packages/adapters/src/` during M0
- `ui/` — the full UI reference: 170 designs (app, emails, PDFs, website), each with its spec. Open `ui/index.html`; read `ui/README.md` before building any screen

## Before the first session

1. Create a GitHub repo and copy these files in.
2. Create a Stedi sandbox account (free); the test API key is needed by M2 (eligibility).
3. Ask for Tebra test access (see `docs/17-decisions.md` DEC-02); the Tebra test runs alongside M1–M5.
4. Julia writes `rules/seed/<specialty>.md`: top 10 payers, common denial reasons and fixes, modifier rules, payer quirks. Claude Code converts it to rule JSON in M2.
5. Pick the pilot specialty so the synthetic charge profile matches it.

## First prompt for Claude Code (after the spec fixes)

> Read CLAUDE.md and every file in docs/. Then propose the M0 plan from docs/16-milestones.md as a task list with the files you will create. Ask me about anything that is ambiguous or that conflicts between docs before writing code.

## Working cadence

- One milestone at a time; each ends with a demo on synthetic data.
- Keep docs current: when a decision changes, update the doc in the same commit.
- Real patient data only after every "Before PHI" item in `docs/11-security-hipaa.md` is done.
