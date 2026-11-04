-- S-03: an admin may reset a member's two-factor only if that person works in no other company,
-- because two-factor belongs to the person, not one company (DEC-22). Memberships are tenant-scoped
-- (RLS), so this answers yes or no, and only for a member of the caller's own company.
CREATE OR REPLACE FUNCTION app.member_elsewhere(p_user_id uuid)
  RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.memberships
        WHERE user_id = p_user_id AND tenant_id = app.current_tenant_id()
      )
      AND EXISTS (
        SELECT 1 FROM public.memberships
        WHERE user_id = p_user_id AND tenant_id <> app.current_tenant_id() AND status = 'active'
      )
  $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.member_elsewhere(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.member_elsewhere(uuid) TO cleanpost_app;
