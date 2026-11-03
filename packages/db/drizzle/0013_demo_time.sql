-- Demo time (DEC-18): one offset from the real clock for local and preview. Two locks keep it out
-- of staging and production: only the system role (the synthetic seed, which runs in local and
-- preview) can set enabled, and the app refuses a non-zero offset outside local and preview
-- (packages/db clock.ts). app.now() is the default for business timestamps; sign-in and session
-- tables keep now().
CREATE TABLE IF NOT EXISTS app.clock (
	"id" smallint PRIMARY KEY DEFAULT 1 CHECK ("id" = 1),
	"enabled" boolean NOT NULL DEFAULT false,
	"offset_ms" bigint NOT NULL DEFAULT 0,
	"updated_at" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint
INSERT INTO app.clock ("id", "offset_ms") VALUES (1, 0) ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.now() RETURNS timestamp with time zone
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT now() + coalesce((SELECT CASE WHEN enabled THEN offset_ms ELSE 0 END FROM app.clock WHERE id = 1), 0) * interval '1 millisecond' $$;--> statement-breakpoint
GRANT SELECT ON app.clock TO cleanpost_app;--> statement-breakpoint
GRANT UPDATE ("offset_ms", "updated_at") ON app.clock TO cleanpost_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.now() TO cleanpost_app;--> statement-breakpoint
ALTER TABLE "audit_events" ALTER COLUMN "at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "clients" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "clients" ALTER COLUMN "updated_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "memberships" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "memberships" ALTER COLUMN "updated_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "tenants" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "tenants" ALTER COLUMN "updated_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "user_preferences" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "user_preferences" ALTER COLUMN "updated_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "code_sets" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "code_sets" ALTER COLUMN "updated_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "mue_limits" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "mue_limits" ALTER COLUMN "updated_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "ncci_edits" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "ncci_edits" ALTER COLUMN "updated_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "payers" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "payers" ALTER COLUMN "updated_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "client_payer_settings" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "client_payer_settings" ALTER COLUMN "updated_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "locations" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "locations" ALTER COLUMN "updated_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "providers" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "providers" ALTER COLUMN "updated_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "coverages" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "coverages" ALTER COLUMN "updated_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "updated_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "eligibility_checks" ALTER COLUMN "requested_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "eligibility_checks" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "eligibility_checks" ALTER COLUMN "updated_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "patients" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "patients" ALTER COLUMN "updated_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "charge_lines" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "charge_lines" ALTER COLUMN "updated_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "claim_events" ALTER COLUMN "occurred_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "claim_events" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "claim_events" ALTER COLUMN "updated_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "claim_lines" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "claim_lines" ALTER COLUMN "updated_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "claim_versions" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "claim_versions" ALTER COLUMN "updated_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "claims" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "claims" ALTER COLUMN "updated_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "diagnoses" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "diagnoses" ALTER COLUMN "updated_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "encounters" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "encounters" ALTER COLUMN "updated_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "scrub_results" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "scrub_results" ALTER COLUMN "updated_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "adjustment_mappings" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "adjustment_mappings" ALTER COLUMN "updated_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "pm_postings" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "pm_postings" ALTER COLUMN "updated_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "postings" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "postings" ALTER COLUMN "updated_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "provider_adjustments" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "provider_adjustments" ALTER COLUMN "updated_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "remit_adjustments" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "remit_adjustments" ALTER COLUMN "updated_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "remit_claims" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "remit_claims" ALTER COLUMN "updated_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "remit_lines" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "remit_lines" ALTER COLUMN "updated_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "remit_remarks" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "remit_remarks" ALTER COLUMN "updated_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "remittances" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "remittances" ALTER COLUMN "updated_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "corrections" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "corrections" ALTER COLUMN "updated_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "notification_rules" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "notification_rules" ALTER COLUMN "updated_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "notifications" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "notifications" ALTER COLUMN "updated_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "rules" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "rules" ALTER COLUMN "updated_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "saved_views" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "saved_views" ALTER COLUMN "updated_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "work_items" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "work_items" ALTER COLUMN "updated_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "write_off_requests" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "write_off_requests" ALTER COLUMN "updated_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "connections" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "connections" ALTER COLUMN "updated_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "external_refs" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "external_refs" ALTER COLUMN "updated_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "manual_tasks" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "manual_tasks" ALTER COLUMN "updated_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "rate_limit_buckets" ALTER COLUMN "refilled_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "rate_limit_buckets" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "rate_limit_buckets" ALTER COLUMN "updated_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "sync_runs" ALTER COLUMN "started_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "sync_runs" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "sync_runs" ALTER COLUMN "updated_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "break_glass_grants" ALTER COLUMN "granted_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "break_glass_grants" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "break_glass_grants" ALTER COLUMN "updated_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "exports" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "exports" ALTER COLUMN "updated_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "integration_requests" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "integration_requests" ALTER COLUMN "updated_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "invoices" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "invoices" ALTER COLUMN "updated_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "platform_banners" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "platform_banners" ALTER COLUMN "updated_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "tenant_agreements" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "tenant_agreements" ALTER COLUMN "updated_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "usage_records" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "usage_records" ALTER COLUMN "updated_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "webhook_events" ALTER COLUMN "received_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "webhook_events" ALTER COLUMN "created_at" SET DEFAULT app.now();--> statement-breakpoint
ALTER TABLE "webhook_events" ALTER COLUMN "updated_at" SET DEFAULT app.now();