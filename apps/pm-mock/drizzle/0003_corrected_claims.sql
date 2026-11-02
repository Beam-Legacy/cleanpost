ALTER TABLE "pm_mock"."claims" ADD COLUMN "frequency_code" text DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE "pm_mock"."claims" ADD COLUMN "original_ref" text;