-- DEC-34 (S-12, S-14, S-10).
-- How each session's second step was done (totp, backup_code, passkey, trusted_device; null for a
-- password alone), and when a second factor was last entered (S-12 step-up).
ALTER TABLE "sessions" ADD COLUMN "second_factor" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "second_factor_at" timestamp with time zone;--> statement-breakpoint
-- S-14: who signed each agreement.
ALTER TABLE "tenant_agreements" ADD COLUMN "signed_by" text;--> statement-breakpoint
-- The company's own files (S-10 logo, S-14 agreements) belong to no client; still company-scoped by RLS.
ALTER TABLE "document_blobs" ALTER COLUMN "client_id" DROP NOT NULL;
