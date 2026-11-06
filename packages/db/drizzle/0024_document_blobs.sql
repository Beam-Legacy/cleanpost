-- DEC-31: card images (and later other documents) in local and preview, encrypted with the field
-- key before they reach the database. Production keeps them in S3 (SSE-KMS) instead (docs/11).
CREATE TABLE "document_blobs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"content_encrypted" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT app.now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT app.now() NOT NULL,
	CONSTRAINT "document_blobs_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "document_blobs_size_check" CHECK ("document_blobs"."size_bytes" between 1 and 15728640)
);
--> statement-breakpoint
ALTER TABLE "document_blobs" ADD CONSTRAINT "document_blobs_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
SELECT app.enable_tenant_rls('document_blobs');
