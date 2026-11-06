ALTER TABLE "patients" ADD COLUMN "source" text DEFAULT 'pm' NOT NULL;--> statement-breakpoint
ALTER TABLE "patients" ADD CONSTRAINT "patients_source_check" CHECK ("patients"."source" in ('pm', 'user'));--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "patient_id" uuid;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "work_items_patient_idx" ON "work_items" USING btree ("patient_id") WHERE "work_items"."patient_id" is not null;--> statement-breakpoint
ALTER TABLE "corrections" ADD COLUMN "entity_type" text;--> statement-breakpoint
ALTER TABLE "corrections" ADD COLUMN "entity_id" uuid;--> statement-breakpoint
-- W-13 (DEC-30): a claim blocked only by its coverage is an eligibility issue, priority 1, about the
-- patient. Open items made before this change become one.
UPDATE "work_items" w SET "type" = 'eligibility_issue', "priority" = 1, "patient_id" = c."patient_id"
  FROM "claims" c
  WHERE c."id" = w."claim_id" AND w."type" = 'claim_blocked' AND w."status" <> 'resolved'
    AND w."reason_code" like 'eligibility.%';
