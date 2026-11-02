CREATE TABLE "write_off_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"denial_item_id" uuid,
	"approval_item_id" uuid,
	"amount_cents" integer NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"pm_code" text NOT NULL,
	"requested_by" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"decision_note" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "write_off_requests_amount_check" CHECK ("write_off_requests"."amount_cents" > 0),
	CONSTRAINT "write_off_requests_status_check" CHECK ("write_off_requests"."status" in ('pending', 'approved', 'declined', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "write_off_requests" ADD CONSTRAINT "write_off_requests_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "write_off_requests" ADD CONSTRAINT "write_off_requests_denial_item_id_work_items_id_fk" FOREIGN KEY ("denial_item_id") REFERENCES "public"."work_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "write_off_requests" ADD CONSTRAINT "write_off_requests_approval_item_id_work_items_id_fk" FOREIGN KEY ("approval_item_id") REFERENCES "public"."work_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "write_off_requests" ADD CONSTRAINT "write_off_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "write_off_requests_claim_idx" ON "write_off_requests" USING btree ("claim_id","status");--> statement-breakpoint
SELECT app.enable_tenant_rls('write_off_requests');
