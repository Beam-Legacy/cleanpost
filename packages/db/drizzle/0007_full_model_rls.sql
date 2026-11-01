-- Row-level security for the full data model (CLAUDE.md rule 1). Every customer table: one tenant policy, forced.
--> statement-breakpoint
SELECT app.enable_tenant_rls('client_payer_settings');
--> statement-breakpoint
SELECT app.enable_tenant_rls('providers');
--> statement-breakpoint
SELECT app.enable_tenant_rls('locations');
--> statement-breakpoint
SELECT app.enable_tenant_rls('patients');
--> statement-breakpoint
SELECT app.enable_tenant_rls('coverages');
--> statement-breakpoint
SELECT app.enable_tenant_rls('eligibility_checks');
--> statement-breakpoint
SELECT app.enable_tenant_rls('documents');
--> statement-breakpoint
SELECT app.enable_tenant_rls('encounters');
--> statement-breakpoint
SELECT app.enable_tenant_rls('charge_lines');
--> statement-breakpoint
SELECT app.enable_tenant_rls('diagnoses');
--> statement-breakpoint
SELECT app.enable_tenant_rls('claims');
--> statement-breakpoint
SELECT app.enable_tenant_rls('claim_versions');
--> statement-breakpoint
SELECT app.enable_tenant_rls('claim_lines');
--> statement-breakpoint
SELECT app.enable_tenant_rls('scrub_results');
--> statement-breakpoint
SELECT app.enable_tenant_rls('claim_events');
--> statement-breakpoint
SELECT app.enable_tenant_rls('remittances');
--> statement-breakpoint
SELECT app.enable_tenant_rls('remit_claims');
--> statement-breakpoint
SELECT app.enable_tenant_rls('remit_lines');
--> statement-breakpoint
SELECT app.enable_tenant_rls('remit_adjustments');
--> statement-breakpoint
SELECT app.enable_tenant_rls('remit_remarks');
--> statement-breakpoint
SELECT app.enable_tenant_rls('provider_adjustments');
--> statement-breakpoint
SELECT app.enable_tenant_rls('adjustment_mappings');
--> statement-breakpoint
SELECT app.enable_tenant_rls('postings');
--> statement-breakpoint
SELECT app.enable_tenant_rls('work_items');
--> statement-breakpoint
SELECT app.enable_tenant_rls('corrections');
--> statement-breakpoint
SELECT app.enable_tenant_rls('saved_views');
--> statement-breakpoint
SELECT app.enable_tenant_rls('notification_rules');
--> statement-breakpoint
SELECT app.enable_tenant_rls('notifications');
--> statement-breakpoint
SELECT app.enable_tenant_rls('connections');
--> statement-breakpoint
SELECT app.enable_tenant_rls('sync_runs');
--> statement-breakpoint
SELECT app.enable_tenant_rls('external_refs');
--> statement-breakpoint
SELECT app.enable_tenant_rls('manual_tasks');
--> statement-breakpoint
SELECT app.enable_tenant_rls('tenant_agreements');
--> statement-breakpoint
SELECT app.enable_tenant_rls('exports');
--> statement-breakpoint
SELECT app.enable_tenant_rls('invoices');
--> statement-breakpoint
SELECT app.enable_tenant_rls('integration_requests');
--> statement-breakpoint
SELECT app.enable_tenant_rls('break_glass_grants');
--> statement-breakpoint
SELECT app.enable_tenant_rls('usage_records');
--> statement-breakpoint
-- Rules: tenant rows as usual, plus global seed rules (tenant_id null) that every tenant can read but none can change.
SELECT app.enable_tenant_rls('rules');
--> statement-breakpoint
CREATE POLICY rules_global_read ON rules FOR SELECT USING (tenant_id IS NULL);
--> statement-breakpoint
-- Global reference data: read-only for the apps; loaded by the system role.
GRANT SELECT ON payers, code_sets, ncci_edits, platform_banners TO cleanpost_app;
--> statement-breakpoint
-- Webhook idempotency records hold IDs only and arrive before a tenant is known.
GRANT SELECT, INSERT, UPDATE ON webhook_events TO cleanpost_app;
--> statement-breakpoint
-- Claims, remittances and their history are never deleted (docs/02-data-model.md).
REVOKE DELETE ON claims, claim_versions, claim_lines, claim_events, scrub_results, remittances, remit_claims, remit_lines, remit_adjustments, remit_remarks, provider_adjustments FROM cleanpost_app;
--> statement-breakpoint
-- A claim version is immutable once released (CLAUDE.md rule 4): corrections create a new version.
CREATE OR REPLACE FUNCTION app.reject_released_version_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'claim version % is released and cannot change', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER claim_versions_immutable_after_release
  BEFORE UPDATE ON claim_versions
  FOR EACH ROW EXECUTE FUNCTION app.reject_released_version_change();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.reject_released_line_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM claim_versions v WHERE v.id = OLD.claim_version_id AND v.released_at IS NOT NULL) THEN
    RAISE EXCEPTION 'claim line % belongs to a released version and cannot change', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER claim_lines_immutable_after_release
  BEFORE UPDATE ON claim_lines
  FOR EACH ROW EXECUTE FUNCTION app.reject_released_line_change();
