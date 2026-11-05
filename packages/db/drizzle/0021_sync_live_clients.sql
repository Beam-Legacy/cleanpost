-- O-10: scheduled syncs start when a client goes live (docs/09 O-10, DEC-27). A client still
-- onboarding is reached only by the wizard's own test and dry run, which store nothing. Paused
-- clients keep syncing (DEC-25); offboarded ones stop.
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
    WHERE c.status IN ('testing', 'healthy', 'degraded') AND cl.status IN ('live', 'paused')
  $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.sync_candidates() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.sync_candidates() TO cleanpost_app;
