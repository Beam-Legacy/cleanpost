# 11 — Security and HIPAA

Cleanpost is a business associate of each billing company (itself a business associate of its practices). Controls below map to the HIPAA Security Rule safeguards. Nothing in production handles real PHI until every item marked **Before PHI** is done.

## Before PHI (production gate)

- [ ] BAAs signed: AWS, Stedi, AWS Bedrock (covered by AWS BAA when using eligible services), any managed-API vendor, email provider (if any PHI could appear; design so none does)
- [ ] Customer agreement and BAA template reviewed by a healthcare attorney
- [ ] Written HIPAA risk analysis and risk management plan
- [ ] Policies: access control, workforce security, incident response and breach notification, contingency/backup, device and media, sanctions, vendor management
- [ ] Security officer and privacy officer named (can be the founders)
- [ ] Workforce HIPAA training completed and recorded
- [ ] Backup restore tested; incident response tabletop run once
- [ ] Penetration test or at least an external vulnerability scan

## Technical controls

| Area | Control |
| --- | --- |
| Identity | better-auth with mandatory MFA (TOTP or passkey); password policy per NIST 800-63B; lockout and alerting |
| Authorization | Role-based (admin, biller, viewer) plus client scope; checks in a single policy module used by every route and job |
| Tenant isolation | Postgres RLS on every customer table, with `tenant_id` denormalized onto child tables; `app.tenant_id` set per transaction; automated cross-tenant tests in CI. Global tables (users and auth tables, reference data, banners) hold no PHI and are reached only through their owning module. The app role's only cross-tenant reads are `app.sync_candidates()` and `app.active_tenants()`, security-definer functions owned by the migration role (which must bypass RLS) that return connection IDs with schedule fields for the sync scheduler, and active tenant IDs for the notification sweep, nothing else; they are covered by the isolation tests. The job queue schema (`pgboss`) holds ID-only payloads and no customer data |
| Encryption in transit | TLS 1.2+ everywhere; HSTS; internal service traffic over TLS |
| Encryption at rest | RDS encryption (KMS), S3 SSE-KMS, field-level encryption for tax IDs, member IDs and SSNs (SSNs are not collected unless a payer requires them). Card photos are encrypted with the field key before storage; local and preview keep them in the database, production in S3 (DEC-31), and they leave storage only through five-minute links signed for one person |
| Secrets | AWS Secrets Manager; no secrets in env files committed to git; rotation schedule |
| Audit | `audit_events` append-only, PHI views included (detail views, reveals, exports, searches); retained 6 years |
| Logging | pino with redaction paths; log scanning in CI for patterns (DOB, member ID, names from synthetic data) |
| Sessions | 15-minute idle timeout, 12-hour absolute; re-auth for exports and settings changes |
| Exports | PHI exports admin-only, watermarked with user and time, audit-logged |
| Vendors | Only BAA-covered vendors receive PHI; analytics and error tracking configured to receive no PHI (scrub at SDK level) |
| Backups | Daily snapshots, 35-day retention, cross-region copy, quarterly restore test |
| Availability | Multi-AZ database; jobs resume after restart; RPO 24h / RTO 8h for MVP |
| Dependency security | Dependabot or Renovate, `pnpm audit` in CI, lockfile pinned |
| Application security | OWASP ASVS L2 as the checklist; CSRF protection; strict CSP; input validation with Zod; output encoding by React |
| Browser automation | Runs in isolated containers per tenant job, no persistent storage beyond the session, credentials injected at runtime |
| Minimum necessary | Lists show reduced identifiers; detail views reveal more on request |

## Data retention

Claims, remittances and audit records: retained per customer contract (default 7 years, matching common CMS and state requirements). Raw documents: same. On offboarding: export provided, then deletion within 30 days except where retention is legally required.

## Breach response

Detect → contain → assess (4-factor risk assessment) → notify the billing company without unreasonable delay and per the BAA timeline (contractually commit to a short window, e.g. 5 business days) → document. Runbook in `docs/runbooks/incident.md` (to be written in milestone M1).

## SOC 2

Deferred until a paying customer requires it (cost plan in the financial model). Build the controls above so the evidence exists when an audit starts.
