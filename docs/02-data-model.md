# 02 — Data model

All tables: `id uuid (v7) pk`, `created_at`, `updated_at`. Every customer-data table has `tenant_id` with RLS, including child tables (`claim_lines`, `remit_lines`, `remit_adjustments`, ...): `tenant_id` is denormalized onto every row so each RLS policy checks one column. Rows scoped to a practice also have `client_id`. Money is `bigint` cents. Soft delete only where noted; claims, remits and audit records are never deleted.

Global tables (no `tenant_id`, no RLS, no PHI): `users` and better-auth's own tables, `payers`, `code_sets`, `ncci_edits`, `platform_banners`. They are read through their owning module only.

## Organization

| Table | Key columns | Notes |
| --- | --- | --- |
| `tenants` | name (display), legal_name, address, phone, timezone, plan, status, billing_email, security_contact jsonb, billing_contact jsonb, settings jsonb (branding, security, notification defaults; DEC-34) | Billing company (S-14, S-10, S-12). `address` is `{ line }`, one line as the company writes it; the contacts are `{ name, email }` |
| `users` | email, name, mfa_enrolled, status | Global identity managed by better-auth, alongside its sessions, accounts, verification, two-factor and passkey tables. `sessions` also records how the second factor was given (`second_factor`: `totp`, `backup_code`, `passkey`, `trusted_device`) and when (`second_factor_at`, renewed by a step-up; DEC-34). No PHI; reached only through the auth module |
| `memberships` | tenant_id, user_id, role (`admin`, `biller`, `viewer`), client_scope (all or list) | A user can belong to more than one tenant. Extra RLS policy: a user can read their own memberships before a tenant is chosen (A-07) |
| `clients` | tenant_id, name, tax_id (encrypted), billing_npi, taxonomy, address, timezone, status (`onboarding`, `live`, `paused`, `offboarded`), default_mode (`A`,`B`,`C`), auto_release_threshold (0–100, null = the company default in `tenants.settings.autoReleaseThreshold`; 100 = review everything, DEC-23), pm_batch_time (time, nullable: when the PM sends its daily batch; CL-03), go_live_at, offboarded_at, baseline (jsonb, the practice's figures before Cleanpost, DEC-25), pause (jsonb while paused: reason, note, resume on), review_until (date, DEC-26), primary_biller_id, backup_biller_id, onboarding (jsonb while onboarding: furthest step, PM chosen, last connection test and dry run with counts, payer names and sample encounter numbers, confirmations, tax ID last four, practice contact; no PHI, DEC-27) | A practice |
| `client_payer_settings` | client_id, payer_id, mode_override, auto_release_threshold_override, era_enrollment_status, edi_enrollment_status, timely_filing_days | Per client and payer |
| `providers` | client_id, npi, name, taxonomy, role (`rendering`,`billing`,`referring`) | |
| `locations` | client_id, name, address, place_of_service, npi | |

## Reference

| Table | Key columns | Notes |
| --- | --- | --- |
| `payers` | stedi_payer_id, name, aliases, supports (eligibility, claims, era, status), enrollment_required | Synced from Stedi Payers API |
| `code_sets` | type (`icd10`,`cpt_code_only`,`hcpcs`,`modifier`,`pos`,`carc`,`rarc`,`claim_status`), code, short_label, effective_from, effective_to | No CPT descriptions until licensed |
| `ncci_edits` | column1_code, column2_code, modifier_indicator, effective dates | CMS public files |
| `fee_schedules` (phase 2) | client_id, payer_id, code, modifier, allowed_cents | Underpayment detection |

## Patients and coverage

| Table | Key columns | Notes |
| --- | --- | --- |
| `patients` | client_id, external_ids jsonb (per connection), first/last name, dob, sex, address, phone, source (`pm`, `user`: corrected in Cleanpost, not yet in the PM; DEC-30) | PHI |
| `coverages` | patient_id, payer_id, priority (1,2,3), member_id, group_number, subscriber relationship, subscriber demographics, effective/termination dates, source (`pm`,`card`,`user`; `card`/`user` = corrected in Cleanpost, not yet in the PM, DEC-30) | |
| `eligibility_checks` | coverage_id, requested_at, status (`active`,`inactive`,`error`,`unknown`), summary jsonb (copay, deductible remaining, coinsurance), raw_ref (storage key) | Raw 271 in object storage |
| `documents` | client_id, patient_id?, type (`insurance_card_front`,`insurance_card_back`,`timely_filing_proof` (W-22),`payer_letter`,`eob`,`other`), storage_key (`cards/<upload>/front` and `/back`), extracted jsonb (status, reader, fields, member ID encrypted, confidence per field, matched payer), extraction_confidence, review_status (`pending`,`accepted`,`corrected`,`rejected`) | PHI |
| `document_blobs` | client_id (null for the company's own files: logo, agreements), storage_key, content_type, size_bytes, content_encrypted | Local and preview document contents, encrypted with the field key (DEC-31); S3 with SSE-KMS in production |

## Encounters and claims

| Table | Key columns | Notes |
| --- | --- | --- |
| `encounters` | client_id, patient_id, external_ids, date_of_service, rendering_provider_id, location_id, referring_provider_id?, prior_auth_number?, status (`open`,`ready`,`claimed`,`void`) | |
| `charge_lines` | encounter_id, external_id, code, modifiers text[4], diagnosis_pointers int[4], units, charge_cents, ndc?, line_note? | |
| `diagnoses` | encounter_id, sequence, icd10 | |
| `claims` | client_id, patient_id, encounter_id, payer_id, coverage_id, patient_control_number (unique per client), pcn_source (`cleanpost`,`pm`), current_version_id, status, mode (`A`,`B`,`C`), total_charge_cents, balance_cents, filing_deadline | Logical claim. In Mode A the PM's clearinghouse assigns the number sent to the payer (`pcn_source = pm`); it is read back from the PM and may be null until then |
| `claim_versions` | claim_id, version, frequency_code (1,7,8), original_ref (payer claim control number for 7/8), payload jsonb (canonical 837 shape), scrub_result_id, created_by | Immutable after release |
| `claim_lines` | claim_version_id, line_number, line_control_number, charge_line_id, code, modifiers, units, charge_cents, dx_pointers | |
| `scrub_results` | claim_version_id, confidence (0–100), findings jsonb[], ai_summary, decision (`auto_release`,`review`,`blocked`), rules_version | |
| `claim_events` | claim_id, claim_version_id?, type (`built`,`scrubbed`,`approved`,`released`,`ack_999`,`ack_277ca`,`status_277`,`rejected`,`paid`,`denied`,`partially_paid`,`reversed`,`corrected`,`closed`,`voided`,`note`), payload jsonb (`event`, `from`, `to` plus details), actor, occurred_at | Full timeline; written by `applyClaimEvent` for every transition |

## Remittance and posting

| Table | Key columns | Notes |
| --- | --- | --- |
| `remittances` | client_id, payer_id, source (`stedi`,`pm`,`file`), trace_number (check/EFT), payment_method (`ACH`,`CHK`,`NON`), payment_amount_cents, payment_date, raw_ref, status | One per 835 transaction/payment |
| `remit_claims` | remittance_id, claim_id?, patient_control_number, payer_claim_control_number, claim_status_code, charge_cents, paid_cents, patient_resp_cents, match_status (`matched`,`unmatched`,`ambiguous`,`set_aside`: billed before go-live or not this client's, W-17), matched_by (`pcn`,`payer_claim_number`,`heuristic`,`manual`) | CLP |
| `remit_lines` | remit_claim_id, claim_line_id?, code, modifiers, charge_cents, allowed_cents?, paid_cents, units, line_control_number, verify_status? (`pending`,`verified`,`mismatch`,`missing`,`unmapped`,`confirmed`: posted by hand and confirmed by a person), verify_detail?, verified_at? | SVC; verify_* from the posting match (Modes A, C) |
| `remit_adjustments` | remit_claim_id or remit_line_id, group_code (`CO`,`PR`,`OA`,`PI`,`CR`), carc, amount_cents, quantity | CAS |
| `remit_remarks` | remit_claim_id or remit_line_id, rarc | LQ / MOA / MIA |
| `provider_adjustments` | remittance_id, reason_code, reference, amount_cents | PLB |
| `adjustment_mappings` | tenant_id, client_id?, pm_type, group_code, carc, pm_adjustment_code, action (`adjust`,`transfer_to_patient`,`write_off`,`info_only`) | Maps to the PM's own codes |
| `pm_postings` | client_id, connection_id, external_key, trace_number, encounter_external_id, line_external_id?, paid_cents, adjustments (PM codes), patient_resp_cents, posted_at | What the PM posted, read with `pullPostings` (Modes A, C) for the posting match |
| `postings` | remittance_id, connection_id, status, method (`api`,`file`,`browser`,`manual`,`pm_native`), attempts, last_error, posted_total_cents, verified_at | |
| `deposits` (phase 2) | client_id, bank_date, amount_cents, trace_number, matched_remittance_id | Bank reconciliation |

## Work and rules

| Table | Key columns | Notes |
| --- | --- | --- |
| `work_items` | client_id, type, status, priority (1–4), due_at, assignee_id?, claim_id?, remittance_id?, remit_claim_id? (the payment an unmatched-payment item is about), encounter_id?, document_id?, patient_id? (patient-level items: W-13, W-14, PM tasks after P-02/P-06), connection_id?, reason_code, summary (no PHI beyond what the UI shows), snoozed_until?, resolved_by, resolution | See `docs/08-work-queue.md` |
| `corrections` | work_item_id, claim_id?, entity_type?/entity_id? (coverage or patient corrections, DEC-30), field_path, before jsonb, after jsonb, user_id, promoted_rule_id? | Training data for rules |
| `write_off_requests` | client_id, claim_id, denial_item_id?, approval_item_id?, amount_cents, reason, note?, pm_code, requested_by, status (`pending`,`approved`,`declined`,`cancelled`), decided_by?, decision_note?, decided_at? | D-03 write-offs over the tenant's approval limit; state machine in `docs/03-state-machines.md`. The note is free text: it stays out of the audit metadata |
| `rules` | scope (`global`,`tenant`,`client`,`payer`,`client_payer`), scope ids, name, kind (`validate`,`transform`,`route`), condition jsonb, action jsonb, severity, enabled, source (`seed`,`user`,`promoted`), version | |

## Users, views and notification settings

| Table | Key columns | Notes |
| --- | --- | --- |
| `user_preferences` | user_id, tenant_id, density (`compact`,`comfortable`), theme, digest_time, quiet_hours jsonb, shortcut_overrides jsonb, checklist jsonb, digest_email, alert_email (the person's own email switches), last_digest_on | A-09, G-06, G-14 |
| `saved_views` | user_id, tenant_id, surface (`work`,`claims`,`remittances`,`denials`), name, filters jsonb, sort jsonb | W-08, C-01 |
| `notification_rules` | tenant_id, event_type (unique per tenant), channels (`in_app`,`email`,`digest`), recipients jsonb, threshold_cents?, enabled; only events a company changed from the defaults (domain `notify`) | S-09 |

## Integrations

| Table | Key columns | Notes |
| --- | --- | --- |
| `connections` | client_id, adapter_key (`mock`,`manual`,`file`,`tebra`,...), level per operation jsonb (0–4 or `unavailable`), credentials_secret_ref, pm_account_ref (connections in one PM account share it, their credential and their rate limit), sync_interval_minutes (null = adapter default), status (`setup`,`testing`,`healthy`,`degraded`,`failed`,`paused`), last_success_at, next_run_at, consecutive_failed_cycles (3 → `failed`) | Credentials live in Secrets Manager |
| `sync_runs` | connection_id, operation, started_at, finished_at, status, counts jsonb (`new`, `changed`, `unchanged`, `failed`), error_code, error_detail (no PHI: PM record IDs and field names only) | One per operation per cycle |
| `external_refs` | connection_id, entity_type (`patient`, `coverage`, `encounter`, `location`), entity_id, external_id | Maps PM IDs to canonical IDs; unique per connection, type and PM ID |
| `rate_limit_buckets` | key (pm_account_ref, or the connection), endpoint, tokens, refilled_at | Token buckets shared by every worker (docs/05-adapters.md) |
| `manual_tasks` | connection_id, operation, work_item_id, title, instructions (steps and worksheet rows), payload_ref (e.g. the remittance for `postPayment`), status (`open`,`escalated`,`done`,`failed`), pm_reference (the PM's ID when done) | Tasks a biller completes in the PM by hand (M-01, M-03) |

## Platform

| Table | Key columns | Notes |
| --- | --- | --- |
| `audit_events` | tenant_id, actor, action, entity_type, entity_id, ip, user_agent, at | Append-only; PHI reads included |
| `tenant_agreements` | tenant_id, type (`baa`,`customer_agreement`), version, signed_at, signed_by, storage_key | S-14 (DEC-34) |
| `exports` | tenant_id, client_id?, type (`report_pdf`,`report_csv`,`claims_csv`,`audit_csv`,`offboarding`), requested_by, status, storage_key, expires_at | RP-06, F-03, CL-11. PHI exports admin-only and audited |
| `invoices` | tenant_id, number, period_start, period_end, amount_cents, status, provider_ref, due_at | S-11, E-07. Built in M7 with the billing provider |
| `integration_requests` | tenant_id, pm_name, client_ids, operations, monthly_volume_estimate, created_by, status | I-05 |
| `break_glass_grants` | tenant_id, operator_user_id, reason, granted_at, expires_at, revoked_at | OP-04. Written by the operator service; tenant admins can read their own |
| `platform_banners` | type, message, starts_at, ends_at, affected jsonb (clients, payers, PMs), link | Global (no tenant). G-13 |
| `usage_records` | tenant_id, client_id, date, claims_released, claims_by_mode jsonb | Invoicing |
| `notifications` | user_id, client_id, type, entity ref, summary, detail, link (app path), urgent, in_app, dedupe_key (unique per tenant and user), emailed_at, read_at | G-04; no PHI in summary or detail (DEC-28) |
| `webhook_events` | source, external_id (unique), received_at, processed_at, status | Idempotency for Stedi webhooks |

## Indexes worth having from day one

- `claims (tenant_id, client_id, status, filing_deadline)`
- `work_items (tenant_id, status, priority, due_at)` and `(assignee_id, status)`
- `remit_claims (patient_control_number)`, `claims (client_id, patient_control_number)` unique
- `external_refs (connection_id, entity_type, external_id)` unique
- `webhook_events (source, external_id)` unique
