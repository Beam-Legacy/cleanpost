# 02 — Data model

All tables: `id uuid (v7) pk`, `created_at`, `updated_at`. Every customer-data table has `tenant_id` with RLS. Rows scoped to a practice also have `client_id`. Money is `bigint` cents. Soft delete only where noted; claims, remits and audit records are never deleted.

## Organization

| Table | Key columns | Notes |
| --- | --- | --- |
| `tenants` | name, plan, status, billing_email, settings jsonb | Billing company |
| `users` | email, name, mfa_enrolled, status | Global identity |
| `memberships` | tenant_id, user_id, role (`admin`, `biller`, `viewer`), client_scope (all or list) | A user can belong to more than one tenant |
| `clients` | tenant_id, name, tax_id (encrypted), billing_npi, taxonomy, address, timezone, status (`onboarding`, `live`, `paused`), default_mode (`A`,`B`,`C`), auto_release_threshold (0–100), go_live_at | A practice |
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
| `patients` | client_id, external_ids jsonb (per connection), first/last name, dob, sex, address, phone | PHI |
| `coverages` | patient_id, payer_id, priority (1,2,3), member_id, group_number, subscriber relationship, subscriber demographics, effective/termination dates, source (`pm`,`card`,`user`) | |
| `eligibility_checks` | coverage_id, requested_at, status (`active`,`inactive`,`error`,`unknown`), summary jsonb (copay, deductible remaining, coinsurance), raw_ref (storage key) | Raw 271 in object storage |
| `documents` | client_id, patient_id?, type (`insurance_card_front`,`insurance_card_back`,`payer_letter`,`eob`,`other`), storage_key, extracted jsonb, extraction_confidence, review_status | |

## Encounters and claims

| Table | Key columns | Notes |
| --- | --- | --- |
| `encounters` | client_id, patient_id, external_ids, date_of_service, rendering_provider_id, location_id, referring_provider_id?, prior_auth_number?, status (`open`,`ready`,`claimed`,`void`) | |
| `charge_lines` | encounter_id, external_id, code, modifiers text[4], diagnosis_pointers int[4], units, charge_cents, ndc?, line_note? | |
| `diagnoses` | encounter_id, sequence, icd10 | |
| `claims` | client_id, patient_id, encounter_id, payer_id, coverage_id, patient_control_number (unique per client), current_version_id, status, mode (`A`,`B`,`C`), total_charge_cents, balance_cents, filing_deadline | Logical claim |
| `claim_versions` | claim_id, version, frequency_code (1,7,8), original_ref (payer claim control number for 7/8), payload jsonb (canonical 837 shape), scrub_result_id, created_by | Immutable after release |
| `claim_lines` | claim_version_id, line_number, line_control_number, charge_line_id, code, modifiers, units, charge_cents, dx_pointers | |
| `scrub_results` | claim_version_id, confidence (0–100), findings jsonb[], ai_summary, decision (`auto_release`,`review`,`blocked`), rules_version | |
| `claim_events` | claim_id, claim_version_id?, type (`built`,`scrubbed`,`approved`,`released`,`ack_999`,`ack_277ca`,`status_277`,`rejected`,`paid`,`denied`,`partially_paid`,`reversed`,`corrected`,`voided`,`note`), payload jsonb, actor, occurred_at | Full timeline |

## Remittance and posting

| Table | Key columns | Notes |
| --- | --- | --- |
| `remittances` | client_id, payer_id, source (`stedi`,`pm`,`file`), trace_number (check/EFT), payment_method (`ACH`,`CHK`,`NON`), payment_amount_cents, payment_date, raw_ref, status | One per 835 transaction/payment |
| `remit_claims` | remittance_id, claim_id?, patient_control_number, payer_claim_control_number, claim_status_code, charge_cents, paid_cents, patient_resp_cents, match_status (`matched`,`unmatched`,`ambiguous`) | CLP |
| `remit_lines` | remit_claim_id, claim_line_id?, code, modifiers, charge_cents, allowed_cents?, paid_cents, units, line_control_number | SVC |
| `remit_adjustments` | remit_claim_id or remit_line_id, group_code (`CO`,`PR`,`OA`,`PI`,`CR`), carc, amount_cents, quantity | CAS |
| `remit_remarks` | remit_claim_id or remit_line_id, rarc | LQ / MOA / MIA |
| `provider_adjustments` | remittance_id, reason_code, reference, amount_cents | PLB |
| `adjustment_mappings` | tenant_id, client_id?, pm_type, group_code, carc, pm_adjustment_code, action (`adjust`,`transfer_to_patient`,`write_off`,`info_only`) | Maps to the PM's own codes |
| `postings` | remittance_id, connection_id, status, method (`api`,`file`,`browser`,`manual`,`pm_native`), attempts, last_error, posted_total_cents, verified_at | |
| `deposits` (phase 2) | client_id, bank_date, amount_cents, trace_number, matched_remittance_id | Bank reconciliation |

## Work and rules

| Table | Key columns | Notes |
| --- | --- | --- |
| `work_items` | client_id, type, status, priority (1–4), due_at, assignee_id?, claim_id?, remittance_id?, encounter_id?, document_id?, connection_id?, reason_code, summary (no PHI beyond what the UI shows), snoozed_until?, resolved_by, resolution | See `docs/08-work-queue.md` |
| `corrections` | work_item_id, field_path, before jsonb, after jsonb, user_id, promoted_rule_id? | Training data for rules |
| `rules` | scope (`global`,`tenant`,`client`,`payer`,`client_payer`), scope ids, name, kind (`validate`,`transform`,`route`), condition jsonb, action jsonb, severity, enabled, source (`seed`,`user`,`promoted`), version | |

## Integrations

| Table | Key columns | Notes |
| --- | --- | --- |
| `connections` | client_id, adapter_key (`mock`,`manual`,`file`,`tebra`,...), level per operation jsonb, credentials_secret_ref, status (`setup`,`healthy`,`degraded`,`failed`,`paused`), last_success_at | Credentials live in Secrets Manager |
| `sync_runs` | connection_id, operation, started_at, finished_at, status, counts jsonb, error_code, error_detail (no PHI) | |
| `external_refs` | connection_id, entity_type, entity_id, external_id | Maps PM IDs to canonical IDs |
| `manual_tasks` | connection_id, operation, work_item_id, payload_ref, status | Tasks a biller completes in the PM by hand |

## Platform

| Table | Key columns | Notes |
| --- | --- | --- |
| `audit_events` | tenant_id, actor, action, entity_type, entity_id, ip, user_agent, at | Append-only; PHI reads included |
| `usage_records` | tenant_id, client_id, date, claims_released, claims_by_mode jsonb | Invoicing |
| `notifications` | user_id, type, entity ref, read_at | |
| `webhook_events` | source, external_id (unique), received_at, processed_at, status | Idempotency for Stedi webhooks |

## Indexes worth having from day one

- `claims (tenant_id, client_id, status, filing_deadline)`
- `work_items (tenant_id, status, priority, due_at)` and `(assignee_id, status)`
- `remit_claims (patient_control_number)`, `claims (client_id, patient_control_number)` unique
- `external_refs (connection_id, entity_type, external_id)` unique
- `webhook_events (source, external_id)` unique
