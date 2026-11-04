ALTER TABLE "clients" ALTER COLUMN "auto_release_threshold" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "clients" ALTER COLUMN "auto_release_threshold" DROP NOT NULL;--> statement-breakpoint
-- S-04: a client at the old default (90) now follows the company default, which starts at 90, so
-- nothing changes until an admin changes it (DEC-23).
UPDATE "clients" SET "auto_release_threshold" = NULL WHERE "auto_release_threshold" = 90;
