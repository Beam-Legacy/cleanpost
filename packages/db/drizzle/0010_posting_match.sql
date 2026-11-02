CREATE TABLE "pm_postings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"external_key" text NOT NULL,
	"trace_number" text NOT NULL,
	"encounter_external_id" text NOT NULL,
	"line_external_id" text,
	"paid_cents" bigint NOT NULL,
	"adjustments" jsonb NOT NULL,
	"patient_resp_cents" bigint NOT NULL,
	"posted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pm_postings_key" UNIQUE("connection_id","external_key")
);
--> statement-breakpoint
ALTER TABLE "remit_lines" ADD COLUMN "verify_status" text;--> statement-breakpoint
ALTER TABLE "remit_lines" ADD COLUMN "verify_detail" jsonb;--> statement-breakpoint
ALTER TABLE "remit_lines" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pm_postings" ADD CONSTRAINT "pm_postings_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pm_postings_trace_idx" ON "pm_postings" USING btree ("client_id","trace_number");--> statement-breakpoint
SELECT app.enable_tenant_rls('pm_postings');
