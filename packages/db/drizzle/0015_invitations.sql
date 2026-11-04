CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"client_scope" text DEFAULT 'all' NOT NULL,
	"client_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"invited_by" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by" uuid,
	"created_at" timestamp with time zone DEFAULT app.now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT app.now() NOT NULL,
	CONSTRAINT "invitations_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "invitations_role_check" CHECK ("invitations"."role" in ('admin', 'biller', 'viewer')),
	CONSTRAINT "invitations_client_scope_check" CHECK ("invitations"."client_scope" in ('all', 'list')),
	CONSTRAINT "invitations_status_check" CHECK ("invitations"."status" in ('pending', 'accepted', 'revoked'))
);
--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invitations_tenant_email_idx" ON "invitations" USING btree ("tenant_id","email");--> statement-breakpoint
SELECT app.enable_tenant_rls('invitations');
--> statement-breakpoint
-- A-06: the person accepting an invite is not signed in and has no tenant yet. This returns one
-- invite by the SHA-256 of its token (never by anything guessable), with only what the accept page
-- shows: no other invite, member or record of the tenant is reachable through it. It runs as its
-- owner, the migration role; accepting then happens inside the invite's tenant.
CREATE OR REPLACE FUNCTION app.invitation_by_token(p_token_hash text)
  RETURNS TABLE (
    id uuid,
    tenant_id uuid,
    tenant_name text,
    email text,
    role text,
    client_scope text,
    client_count integer,
    inviter_name text,
    status text,
    expires_at timestamptz
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT i.id, i.tenant_id, t.name, i.email, i.role, i.client_scope, cardinality(i.client_ids),
      u.name, i.status, i.expires_at
    FROM public.invitations i
    JOIN public.tenants t ON t.id = i.tenant_id
    JOIN public.users u ON u.id = i.invited_by
    WHERE i.token_hash = p_token_hash AND length(p_token_hash) = 64
  $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.invitation_by_token(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.invitation_by_token(text) TO cleanpost_app;
