ALTER TABLE "users" ADD COLUMN "failed_sign_in_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "locked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "known_devices" text[] DEFAULT '{}'::text[] NOT NULL;