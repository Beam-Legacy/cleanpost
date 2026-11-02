CREATE SCHEMA IF NOT EXISTS "payer_sim";
--> statement-breakpoint
CREATE TABLE "payer_sim"."clock" (
	"id" integer PRIMARY KEY NOT NULL,
	"offset_ms" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payer_sim"."submissions" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"patient_control_number" text NOT NULL,
	"payer_name" text NOT NULL,
	"claim" jsonb NOT NULL,
	"received_at" timestamp (3) with time zone NOT NULL,
	"ack_due_at" timestamp (3) with time zone NOT NULL,
	"ack_status" text NOT NULL,
	"ack_codes" text[] NOT NULL,
	"ack_reasons" text[] NOT NULL
);
--> statement-breakpoint
CREATE INDEX "submissions_source_due_idx" ON "payer_sim"."submissions" USING btree ("source","ack_due_at");