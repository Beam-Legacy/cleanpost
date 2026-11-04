ALTER TABLE "clients" ADD COLUMN "review_until" date;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "primary_biller_id" uuid;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "backup_biller_id" uuid;