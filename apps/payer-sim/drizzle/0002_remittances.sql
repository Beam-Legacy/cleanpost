CREATE TABLE "payer_sim"."remittances" (
	"id" text PRIMARY KEY NOT NULL,
	"control" integer NOT NULL,
	"source" text NOT NULL,
	"payer_id" text NOT NULL,
	"payer_name" text NOT NULL,
	"trace_number" text NOT NULL,
	"method" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"payment_date" text NOT NULL,
	"claim_count" integer NOT NULL,
	"x12" text NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "remittances_control_unique" UNIQUE("control")
);
--> statement-breakpoint
ALTER TABLE "payer_sim"."submissions" ADD COLUMN "payer_id" text;--> statement-breakpoint
ALTER TABLE "payer_sim"."submissions" ADD COLUMN "member_id" text;--> statement-breakpoint
ALTER TABLE "payer_sim"."submissions" ADD COLUMN "date_of_service" text;--> statement-breakpoint
ALTER TABLE "payer_sim"."submissions" ADD COLUMN "adjudicate_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "payer_sim"."submissions" ADD COLUMN "adjudication" jsonb;--> statement-breakpoint
ALTER TABLE "payer_sim"."submissions" ADD COLUMN "remittance_id" text;--> statement-breakpoint
ALTER TABLE "payer_sim"."submissions" ADD COLUMN "replaces" text;--> statement-breakpoint
CREATE INDEX "remittances_source_created_idx" ON "payer_sim"."remittances" USING btree ("source","created_at");--> statement-breakpoint
CREATE INDEX "submissions_adjudicate_idx" ON "payer_sim"."submissions" USING btree ("adjudicate_at");--> statement-breakpoint
CREATE INDEX "submissions_member_idx" ON "payer_sim"."submissions" USING btree ("source","member_id","date_of_service");