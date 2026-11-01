CREATE TABLE "rate_limit_buckets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"endpoint" text NOT NULL,
	"tokens" double precision NOT NULL,
	"refilled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_limit_buckets_key" UNIQUE("tenant_id","key","endpoint")
);
--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "consecutive_failed_cycles" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
SELECT app.enable_tenant_rls('rate_limit_buckets');
--> statement-breakpoint
-- The sync scheduler needs to know which connections are due across every tenant. This function is
-- the only cross-tenant read the app role has (docs/11-security-hipaa.md): connection IDs and
-- schedule fields only, no customer data. It runs as its owner, the migration role, which bypasses
-- row-level security; the worker then works on each connection inside that connection's tenant.
CREATE OR REPLACE FUNCTION app.sync_candidates()
  RETURNS TABLE (
    tenant_id uuid,
    connection_id uuid,
    adapter_key text,
    status text,
    sync_interval_minutes integer,
    last_success_at timestamptz,
    next_run_at timestamptz
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT c.tenant_id, c.id, c.adapter_key, c.status, c.sync_interval_minutes, c.last_success_at, c.next_run_at
    FROM public.connections c
    JOIN public.clients cl ON cl.id = c.client_id
    WHERE c.status IN ('testing', 'healthy', 'degraded') AND cl.status <> 'offboarded'
  $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.sync_candidates() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.sync_candidates() TO cleanpost_app;
