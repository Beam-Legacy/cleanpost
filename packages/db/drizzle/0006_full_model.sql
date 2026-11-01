CREATE TABLE "code_sets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"type" text NOT NULL,
	"code" text NOT NULL,
	"short_label" text,
	"effective_from" date,
	"effective_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "code_sets_type_code_from_key" UNIQUE("type","code","effective_from")
);
--> statement-breakpoint
CREATE TABLE "ncci_edits" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"column1_code" text NOT NULL,
	"column2_code" text NOT NULL,
	"modifier_indicator" text NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"stedi_payer_id" text,
	"name" text NOT NULL,
	"aliases" text[] DEFAULT '{}' NOT NULL,
	"supports" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enrollment_required" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payers_stedi_payer_id_unique" UNIQUE("stedi_payer_id")
);
--> statement-breakpoint
CREATE TABLE "client_payer_settings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"payer_id" uuid NOT NULL,
	"mode_override" text,
	"auto_release_threshold_override" smallint,
	"era_enrollment_status" text DEFAULT 'not_started' NOT NULL,
	"edi_enrollment_status" text DEFAULT 'not_started' NOT NULL,
	"timely_filing_days" integer DEFAULT 90 NOT NULL,
	"pm_payer_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_payer_settings_client_payer_key" UNIQUE("client_id","payer_id"),
	CONSTRAINT "client_payer_settings_mode_check" CHECK ("client_payer_settings"."mode_override" is null or "client_payer_settings"."mode_override" in ('A', 'B', 'C'))
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"name" text NOT NULL,
	"address" jsonb,
	"place_of_service" text DEFAULT '11' NOT NULL,
	"npi" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "providers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"npi" text NOT NULL,
	"name" text NOT NULL,
	"taxonomy" text,
	"role" text DEFAULT 'rendering' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "providers_client_npi_key" UNIQUE("client_id","npi")
);
--> statement-breakpoint
CREATE TABLE "coverages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"payer_id" uuid,
	"payer_name" text NOT NULL,
	"priority" smallint NOT NULL,
	"member_id_encrypted" text NOT NULL,
	"member_id_last4" text NOT NULL,
	"group_number" text,
	"relationship" text DEFAULT 'self' NOT NULL,
	"subscriber" jsonb,
	"effective_date" date,
	"termination_date" date,
	"source" text DEFAULT 'pm' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coverages_priority_check" CHECK ("coverages"."priority" between 1 and 3)
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"patient_id" uuid,
	"type" text NOT NULL,
	"storage_key" text NOT NULL,
	"extracted" jsonb,
	"extraction_confidence" numeric(4, 3),
	"review_status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eligibility_checks" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"coverage_id" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"raw_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patients" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"external_ids" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"dob" date NOT NULL,
	"sex" text DEFAULT 'U' NOT NULL,
	"address" jsonb,
	"phone" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patients_sex_check" CHECK ("patients"."sex" in ('M', 'F', 'U'))
);
--> statement-breakpoint
CREATE TABLE "charge_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"external_id" text,
	"line_number" smallint NOT NULL,
	"code" text NOT NULL,
	"modifiers" text[] DEFAULT '{}'::text[] NOT NULL,
	"diagnosis_pointers" smallint[] DEFAULT '{}'::smallint[] NOT NULL,
	"units" integer DEFAULT 1 NOT NULL,
	"charge_cents" bigint NOT NULL,
	"ndc" text,
	"line_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "charge_lines_units_check" CHECK ("charge_lines"."units" > 0)
);
--> statement-breakpoint
CREATE TABLE "claim_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"claim_version_id" uuid,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claim_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"claim_version_id" uuid NOT NULL,
	"line_number" smallint NOT NULL,
	"line_control_number" text,
	"charge_line_id" uuid,
	"code" text NOT NULL,
	"modifiers" text[] DEFAULT '{}'::text[] NOT NULL,
	"units" integer DEFAULT 1 NOT NULL,
	"charge_cents" bigint NOT NULL,
	"dx_pointers" smallint[] DEFAULT '{}'::smallint[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claim_lines_version_line_key" UNIQUE("claim_version_id","line_number")
);
--> statement-breakpoint
CREATE TABLE "claim_versions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"frequency_code" text DEFAULT '1' NOT NULL,
	"original_ref" text,
	"payload" jsonb NOT NULL,
	"scrub_result_id" uuid,
	"created_by" text NOT NULL,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claim_versions_claim_version_key" UNIQUE("claim_id","version"),
	CONSTRAINT "claim_versions_frequency_check" CHECK ("claim_versions"."frequency_code" in ('1', '7', '8'))
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"payer_id" uuid,
	"coverage_id" uuid,
	"patient_control_number" text,
	"pcn_source" text DEFAULT 'cleanpost' NOT NULL,
	"current_version_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"mode" text NOT NULL,
	"total_charge_cents" bigint DEFAULT 0 NOT NULL,
	"balance_cents" bigint DEFAULT 0 NOT NULL,
	"filing_deadline" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claims_client_pcn_key" UNIQUE("client_id","patient_control_number"),
	CONSTRAINT "claims_mode_check" CHECK ("claims"."mode" in ('A', 'B', 'C')),
	CONSTRAINT "claims_pcn_source_check" CHECK ("claims"."pcn_source" in ('cleanpost', 'pm'))
);
--> statement-breakpoint
CREATE TABLE "diagnoses" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"sequence" smallint NOT NULL,
	"icd10" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "diagnoses_encounter_sequence_key" UNIQUE("encounter_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "encounters" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"external_ids" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"date_of_service" date NOT NULL,
	"rendering_provider_id" uuid,
	"referring_provider_id" uuid,
	"location_id" uuid,
	"prior_auth_number" text,
	"status" text DEFAULT 'open' NOT NULL,
	"pm_status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "encounters_status_check" CHECK ("encounters"."status" in ('open', 'ready', 'claimed', 'void'))
);
--> statement-breakpoint
CREATE TABLE "scrub_results" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"claim_version_id" uuid NOT NULL,
	"confidence" smallint NOT NULL,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ai_summary" text,
	"decision" text NOT NULL,
	"rules_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "adjustment_mappings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid,
	"pm_type" text NOT NULL,
	"group_code" text NOT NULL,
	"carc" text NOT NULL,
	"pm_adjustment_code" text NOT NULL,
	"action" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "adjustment_mappings_key" UNIQUE NULLS NOT DISTINCT("tenant_id","client_id","pm_type","group_code","carc")
);
--> statement-breakpoint
CREATE TABLE "postings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"remittance_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"method" text NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"last_error" text,
	"posted_total_cents" bigint DEFAULT 0 NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"remittance_id" uuid NOT NULL,
	"reason_code" text NOT NULL,
	"reference" text,
	"amount_cents" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "remit_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"remit_claim_id" uuid,
	"remit_line_id" uuid,
	"group_code" text NOT NULL,
	"carc" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"quantity" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "remit_adjustments_parent_check" CHECK (num_nonnulls("remit_adjustments"."remit_claim_id", "remit_adjustments"."remit_line_id") = 1),
	CONSTRAINT "remit_adjustments_group_check" CHECK ("remit_adjustments"."group_code" in ('CO', 'PR', 'OA', 'PI', 'CR'))
);
--> statement-breakpoint
CREATE TABLE "remit_claims" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"remittance_id" uuid NOT NULL,
	"claim_id" uuid,
	"patient_control_number" text,
	"payer_claim_control_number" text,
	"claim_status_code" text NOT NULL,
	"charge_cents" bigint NOT NULL,
	"paid_cents" bigint NOT NULL,
	"patient_resp_cents" bigint DEFAULT 0 NOT NULL,
	"match_status" text DEFAULT 'unmatched' NOT NULL,
	"matched_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "remit_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"remit_claim_id" uuid NOT NULL,
	"claim_line_id" uuid,
	"code" text NOT NULL,
	"modifiers" text[] DEFAULT '{}'::text[] NOT NULL,
	"charge_cents" bigint NOT NULL,
	"allowed_cents" bigint,
	"paid_cents" bigint NOT NULL,
	"units" integer DEFAULT 1 NOT NULL,
	"line_control_number" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "remit_remarks" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"remit_claim_id" uuid,
	"remit_line_id" uuid,
	"rarc" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "remit_remarks_parent_check" CHECK (num_nonnulls("remit_remarks"."remit_claim_id", "remit_remarks"."remit_line_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "remittances" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"payer_id" uuid,
	"payer_name" text NOT NULL,
	"source" text NOT NULL,
	"trace_number" text NOT NULL,
	"payment_method" text NOT NULL,
	"payment_amount_cents" bigint NOT NULL,
	"payment_date" date NOT NULL,
	"raw_ref" text,
	"status" text DEFAULT 'received' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "remittances_idempotency_key" UNIQUE("client_id","payer_name","trace_number","payment_amount_cents","payment_date"),
	CONSTRAINT "remittances_method_check" CHECK ("remittances"."payment_method" in ('ACH', 'CHK', 'NON'))
);
--> statement-breakpoint
CREATE TABLE "corrections" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid,
	"work_item_id" uuid,
	"claim_id" uuid,
	"field_path" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"user_id" uuid,
	"promoted_rule_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_rules" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"channels" text[] DEFAULT '{in_app}'::text[] NOT NULL,
	"recipients" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"threshold_cents" integer,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"entity_type" text,
	"entity_id" uuid,
	"summary" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rules" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid,
	"scope" text NOT NULL,
	"client_id" uuid,
	"payer_id" uuid,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"condition" jsonb NOT NULL,
	"action" jsonb NOT NULL,
	"severity" text NOT NULL,
	"weight" smallint DEFAULT 15 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"source" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_views" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"surface" text NOT NULL,
	"name" text NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sort" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"shared" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_items" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid,
	"type" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"priority" smallint DEFAULT 3 NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"assignee_id" uuid,
	"claim_id" uuid,
	"remittance_id" uuid,
	"encounter_id" uuid,
	"document_id" uuid,
	"connection_id" uuid,
	"reason_code" text NOT NULL,
	"summary" text NOT NULL,
	"amount_cents" integer,
	"snoozed_until" timestamp with time zone,
	"resolved_by" text,
	"resolution" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_items_priority_check" CHECK ("work_items"."priority" between 1 and 4)
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"adapter_key" text NOT NULL,
	"levels" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"credentials_secret_ref" text,
	"pm_account_ref" text,
	"sync_interval_minutes" integer,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'setup' NOT NULL,
	"last_success_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"credentials_rotated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connections_status_check" CHECK ("connections"."status" in ('setup', 'testing', 'healthy', 'degraded', 'failed', 'paused'))
);
--> statement-breakpoint
CREATE TABLE "external_refs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_refs_key" UNIQUE("connection_id","entity_type","external_id")
);
--> statement-breakpoint
CREATE TABLE "manual_tasks" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"work_item_id" uuid,
	"title" text NOT NULL,
	"instructions" text[] DEFAULT '{}'::text[] NOT NULL,
	"payload_ref" text,
	"status" text DEFAULT 'open' NOT NULL,
	"pm_reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text DEFAULT 'running' NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_code" text,
	"error_detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "break_glass_grants" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"operator_user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exports" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid,
	"type" text NOT NULL,
	"requested_by" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"storage_key" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"pm_name" text NOT NULL,
	"client_ids" uuid[] DEFAULT '{}' NOT NULL,
	"operations" text[] DEFAULT '{}' NOT NULL,
	"monthly_volume_estimate" integer,
	"created_by" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"amount_cents" bigint NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"provider_ref" text,
	"due_at" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_banners" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"type" text NOT NULL,
	"message" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"affected" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"link" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_agreements" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type" text NOT NULL,
	"version" text NOT NULL,
	"signed_at" timestamp with time zone,
	"storage_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_records" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"date" date NOT NULL,
	"claims_released" integer DEFAULT 0 NOT NULL,
	"claims_by_mode" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_records_client_date_key" UNIQUE("client_id","date")
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"status" text DEFAULT 'received' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_events_source_external_key" UNIQUE("source","external_id")
);
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "tax_id_encrypted" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "address" jsonb;--> statement-breakpoint
ALTER TABLE "client_payer_settings" ADD CONSTRAINT "client_payer_settings_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_payer_settings" ADD CONSTRAINT "client_payer_settings_payer_id_payers_id_fk" FOREIGN KEY ("payer_id") REFERENCES "public"."payers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "providers" ADD CONSTRAINT "providers_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coverages" ADD CONSTRAINT "coverages_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coverages" ADD CONSTRAINT "coverages_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coverages" ADD CONSTRAINT "coverages_payer_id_payers_id_fk" FOREIGN KEY ("payer_id") REFERENCES "public"."payers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eligibility_checks" ADD CONSTRAINT "eligibility_checks_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eligibility_checks" ADD CONSTRAINT "eligibility_checks_coverage_id_coverages_id_fk" FOREIGN KEY ("coverage_id") REFERENCES "public"."coverages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patients" ADD CONSTRAINT "patients_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charge_lines" ADD CONSTRAINT "charge_lines_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charge_lines" ADD CONSTRAINT "charge_lines_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_events" ADD CONSTRAINT "claim_events_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_events" ADD CONSTRAINT "claim_events_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_events" ADD CONSTRAINT "claim_events_claim_version_id_claim_versions_id_fk" FOREIGN KEY ("claim_version_id") REFERENCES "public"."claim_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_lines" ADD CONSTRAINT "claim_lines_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_lines" ADD CONSTRAINT "claim_lines_claim_version_id_claim_versions_id_fk" FOREIGN KEY ("claim_version_id") REFERENCES "public"."claim_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_lines" ADD CONSTRAINT "claim_lines_charge_line_id_charge_lines_id_fk" FOREIGN KEY ("charge_line_id") REFERENCES "public"."charge_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_versions" ADD CONSTRAINT "claim_versions_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_versions" ADD CONSTRAINT "claim_versions_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_payer_id_payers_id_fk" FOREIGN KEY ("payer_id") REFERENCES "public"."payers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_coverage_id_coverages_id_fk" FOREIGN KEY ("coverage_id") REFERENCES "public"."coverages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagnoses" ADD CONSTRAINT "diagnoses_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagnoses" ADD CONSTRAINT "diagnoses_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_rendering_provider_id_providers_id_fk" FOREIGN KEY ("rendering_provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_referring_provider_id_providers_id_fk" FOREIGN KEY ("referring_provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scrub_results" ADD CONSTRAINT "scrub_results_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scrub_results" ADD CONSTRAINT "scrub_results_claim_version_id_claim_versions_id_fk" FOREIGN KEY ("claim_version_id") REFERENCES "public"."claim_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adjustment_mappings" ADD CONSTRAINT "adjustment_mappings_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "postings" ADD CONSTRAINT "postings_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "postings" ADD CONSTRAINT "postings_remittance_id_remittances_id_fk" FOREIGN KEY ("remittance_id") REFERENCES "public"."remittances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_adjustments" ADD CONSTRAINT "provider_adjustments_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_adjustments" ADD CONSTRAINT "provider_adjustments_remittance_id_remittances_id_fk" FOREIGN KEY ("remittance_id") REFERENCES "public"."remittances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remit_adjustments" ADD CONSTRAINT "remit_adjustments_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remit_adjustments" ADD CONSTRAINT "remit_adjustments_remit_claim_id_remit_claims_id_fk" FOREIGN KEY ("remit_claim_id") REFERENCES "public"."remit_claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remit_adjustments" ADD CONSTRAINT "remit_adjustments_remit_line_id_remit_lines_id_fk" FOREIGN KEY ("remit_line_id") REFERENCES "public"."remit_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remit_claims" ADD CONSTRAINT "remit_claims_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remit_claims" ADD CONSTRAINT "remit_claims_remittance_id_remittances_id_fk" FOREIGN KEY ("remittance_id") REFERENCES "public"."remittances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remit_claims" ADD CONSTRAINT "remit_claims_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remit_lines" ADD CONSTRAINT "remit_lines_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remit_lines" ADD CONSTRAINT "remit_lines_remit_claim_id_remit_claims_id_fk" FOREIGN KEY ("remit_claim_id") REFERENCES "public"."remit_claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remit_lines" ADD CONSTRAINT "remit_lines_claim_line_id_claim_lines_id_fk" FOREIGN KEY ("claim_line_id") REFERENCES "public"."claim_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remit_remarks" ADD CONSTRAINT "remit_remarks_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remit_remarks" ADD CONSTRAINT "remit_remarks_remit_claim_id_remit_claims_id_fk" FOREIGN KEY ("remit_claim_id") REFERENCES "public"."remit_claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remit_remarks" ADD CONSTRAINT "remit_remarks_remit_line_id_remit_lines_id_fk" FOREIGN KEY ("remit_line_id") REFERENCES "public"."remit_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remittances" ADD CONSTRAINT "remittances_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remittances" ADD CONSTRAINT "remittances_payer_id_payers_id_fk" FOREIGN KEY ("payer_id") REFERENCES "public"."payers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corrections" ADD CONSTRAINT "corrections_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corrections" ADD CONSTRAINT "corrections_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corrections" ADD CONSTRAINT "corrections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_refs" ADD CONSTRAINT "external_refs_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_refs" ADD CONSTRAINT "external_refs_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_tasks" ADD CONSTRAINT "manual_tasks_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_tasks" ADD CONSTRAINT "manual_tasks_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_requests" ADD CONSTRAINT "integration_requests_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ncci_edits_pair_idx" ON "ncci_edits" USING btree ("column1_code","column2_code");--> statement-breakpoint
CREATE INDEX "payers_name_idx" ON "payers" USING btree ("name");--> statement-breakpoint
CREATE INDEX "locations_client_idx" ON "locations" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "providers_client_idx" ON "providers" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "coverages_patient_idx" ON "coverages" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "documents_patient_idx" ON "documents" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "eligibility_checks_coverage_idx" ON "eligibility_checks" USING btree ("coverage_id","requested_at");--> statement-breakpoint
CREATE INDEX "patients_client_name_idx" ON "patients" USING btree ("client_id","last_name","first_name");--> statement-breakpoint
CREATE INDEX "charge_lines_encounter_idx" ON "charge_lines" USING btree ("encounter_id");--> statement-breakpoint
CREATE INDEX "claim_events_claim_idx" ON "claim_events" USING btree ("claim_id","occurred_at");--> statement-breakpoint
CREATE INDEX "claims_tenant_client_status_deadline_idx" ON "claims" USING btree ("tenant_id","client_id","status","filing_deadline");--> statement-breakpoint
CREATE INDEX "encounters_client_dos_idx" ON "encounters" USING btree ("client_id","date_of_service");--> statement-breakpoint
CREATE INDEX "remit_claims_pcn_idx" ON "remit_claims" USING btree ("patient_control_number");--> statement-breakpoint
CREATE INDEX "remit_claims_remittance_idx" ON "remit_claims" USING btree ("remittance_id");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","read_at");--> statement-breakpoint
CREATE INDEX "rules_scope_idx" ON "rules" USING btree ("tenant_id","scope","enabled");--> statement-breakpoint
CREATE INDEX "work_items_queue_idx" ON "work_items" USING btree ("tenant_id","status","priority","due_at");--> statement-breakpoint
CREATE INDEX "work_items_assignee_idx" ON "work_items" USING btree ("assignee_id","status");--> statement-breakpoint
CREATE INDEX "connections_client_idx" ON "connections" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "sync_runs_connection_idx" ON "sync_runs" USING btree ("connection_id","started_at");--> statement-breakpoint
CREATE INDEX "webhook_events_status_idx" ON "webhook_events" USING btree ("status");