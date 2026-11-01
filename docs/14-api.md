# 14 — Internal API and webhooks

The web app uses server actions and route handlers under `/api`. All routes: authenticated session, tenant from the session (never from the request body), Zod-validated input, policy check, audit where PHI is read or written. Responses never include fields the user's role cannot see.

## Route groups

| Group | Routes (examples) | Notes |
| --- | --- | --- |
| Work | `GET /api/work-items?filters`, `POST /api/work-items/:id/{assign,snooze,resolve,reopen}`, `POST /api/work-items/bulk` | Cursor pagination |
| Claims | `GET /api/claims`, `GET /api/claims/:id`, `POST /api/claims/:id/{approve,hold,void,status-check}`, `POST /api/claims/:id/versions` (create correction), `POST /api/claims/:id/scrub` (preview, no save) | Release happens in a job |
| Patients | `GET /api/patients/search`, `GET /api/patients/:id`, `PATCH /api/patients/:id`, `POST /api/coverages/:id/eligibility` | Patch writes back through the adapter |
| Documents | `POST /api/documents` (signed upload URL), `GET /api/documents/:id` (signed view URL, short expiry) | |
| Remittances | `GET /api/remittances`, `GET /api/remittances/:id`, `POST /api/remittances/upload`, `POST /api/remittances/:id/{post,link-claim}` | |
| Clients | CRUD, `POST /api/clients/:id/{test-connection,dry-run,go-live,pause}` | Admin |
| Connections | `GET /api/connections`, `POST /api/connections/:id/{run,reauth,pause}` | Admin |
| Settings | rules, mappings, users, thresholds, notifications, branding | Admin |
| Reports | `GET /api/reports/:report?clientId&from&to`, `GET /api/reports/:report/export?format=pdf|csv` | |
| Search | `GET /api/search?q` | Audit-logged |
| Operator | `/api/operator/*` | Separate role; returns IDs and counts only |

## Inbound webhooks

| Endpoint | Source | Handling |
| --- | --- | --- |
| `POST /api/webhooks/stedi` | Stedi | Verify signature/secret; store in `webhook_events` (unique on external ID); return 200 fast; enqueue `claim.ack` or `remit.ingest` with IDs only |
| `POST /api/webhooks/pm/:connectionId` | PMs that support callbacks (future) | Same pattern |
| `POST /internal/payer-sim/*` | Simulator (non-production only) | Disabled in production builds |

## Error format

`{ error: { code: 'VALIDATION' | 'NOT_FOUND' | 'FORBIDDEN' | 'CONFLICT' | 'RATE_LIMITED' | 'INTERNAL', message: string, fields?: Record<string,string> } }` — messages contain no PHI.
