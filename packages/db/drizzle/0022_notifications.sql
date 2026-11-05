ALTER TABLE "user_preferences" ADD COLUMN "digest_email" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "alert_email" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "last_digest_on" date;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "detail" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "link" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "urgent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "in_app" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "emailed_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_user_dedupe_key" ON "notifications" USING btree ("tenant_id","user_id","dedupe_key") WHERE "notifications"."dedupe_key" is not null;--> statement-breakpoint
ALTER TABLE "notification_rules" ADD CONSTRAINT "notification_rules_tenant_event_key" UNIQUE("tenant_id","event_type");--> statement-breakpoint
-- The notification sweep (packages/notify) runs for every company. Like app.sync_candidates(), this
-- is a cross-tenant read of IDs only, for the worker; everything else runs inside each tenant.
CREATE OR REPLACE FUNCTION app.active_tenants()
  RETURNS TABLE (tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT t.id FROM public.tenants t WHERE t.status = 'active'
  $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.active_tenants() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.active_tenants() TO cleanpost_app;
