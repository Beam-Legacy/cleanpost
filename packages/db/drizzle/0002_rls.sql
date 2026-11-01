-- Row-level security for every customer-data table (CLAUDE.md rule 1, docs/11-security-hipaa.md).
-- The apps connect as a member of cleanpost_app, which never has BYPASSRLS. Every query runs in a
-- transaction that sets app.tenant_id (and app.user_id); with nothing set, tenant tables return no rows.

CREATE SCHEMA IF NOT EXISTS app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint
DO $$
BEGIN
  -- Local and CI create this role in docker/postgres/init.sql; production creates it in infrastructure code.
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cleanpost_app') THEN
    CREATE ROLE cleanpost_app NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public, app TO cleanpost_app;
--> statement-breakpoint
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.current_tenant_id(), app.current_user_id() TO cleanpost_app;
--> statement-breakpoint
-- Standard tenant isolation for a table with tenant_id. Migrations call this for every new customer table.
CREATE OR REPLACE FUNCTION app.enable_tenant_rls(tbl regclass) RETURNS void
  LANGUAGE plpgsql
  AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', tbl);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s USING (tenant_id = app.current_tenant_id()) '
    'WITH CHECK (tenant_id = app.current_tenant_id())', tbl);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO cleanpost_app', tbl);
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.enable_tenant_rls(regclass) FROM PUBLIC;
--> statement-breakpoint

-- Global auth tables: no tenant, no PHI, reached only through the auth module.
GRANT SELECT, INSERT, UPDATE, DELETE ON users, sessions, accounts, verifications, two_factors, passkeys TO cleanpost_app;
--> statement-breakpoint

-- Tenants: the current tenant, plus read access to tenants the current user belongs to (A-07 Choose company).
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_self ON tenants
  USING (id = app.current_tenant_id())
  WITH CHECK (id = app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY tenant_member_read ON tenants FOR SELECT
  USING (id IN (SELECT m.tenant_id FROM memberships m WHERE m.user_id = app.current_user_id() AND m.status = 'active'));
--> statement-breakpoint
-- Tenants are created by Cleanpost staff through the system role, never by the apps.
GRANT SELECT, UPDATE ON tenants TO cleanpost_app;
--> statement-breakpoint

SELECT app.enable_tenant_rls('memberships');
--> statement-breakpoint
CREATE POLICY membership_self_read ON memberships FOR SELECT
  USING (user_id = app.current_user_id());
--> statement-breakpoint
SELECT app.enable_tenant_rls('clients');
--> statement-breakpoint
SELECT app.enable_tenant_rls('user_preferences');
--> statement-breakpoint
SELECT app.enable_tenant_rls('audit_events');
--> statement-breakpoint

-- audit_events is append-only (docs/11-security-hipaa.md), for the apps and the owner alike.
REVOKE UPDATE, DELETE ON audit_events FROM cleanpost_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.reject_audit_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only' USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION app.reject_audit_change();
