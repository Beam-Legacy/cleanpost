CREATE TABLE "mue_limits" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"code" text NOT NULL,
	"max_units" integer NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mue_limits_code_from_key" UNIQUE("code","effective_from")
);
--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "key" text;--> statement-breakpoint
-- Seed and promoted rules are found by key; one per key across global rules, one per key per tenant.
CREATE UNIQUE INDEX "rules_global_key" ON "rules" ("key") WHERE "tenant_id" IS NULL AND "key" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "rules_tenant_key" ON "rules" ("tenant_id", "key") WHERE "tenant_id" IS NOT NULL AND "key" IS NOT NULL;
--> statement-breakpoint
-- Reference data: read-only for the apps, like code_sets and ncci_edits.
GRANT SELECT ON "mue_limits" TO cleanpost_app;
