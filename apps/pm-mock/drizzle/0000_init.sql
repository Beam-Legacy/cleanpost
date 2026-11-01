CREATE SCHEMA IF NOT EXISTS "pm_mock";
--> statement-breakpoint
CREATE TABLE "pm_mock"."accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"profile" text NOT NULL,
	"api_key_hash" text NOT NULL,
	"faults" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pm_mock"."adjustment_codes" (
	"practice_id" text NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	CONSTRAINT "adjustment_codes_practice_id_code_pk" PRIMARY KEY("practice_id","code")
);
--> statement-breakpoint
CREATE TABLE "pm_mock"."answer_key" (
	"practice_id" text NOT NULL,
	"record_type" text NOT NULL,
	"record_id" text NOT NULL,
	"facts" jsonb NOT NULL,
	CONSTRAINT "answer_key_practice_id_record_type_record_id_pk" PRIMARY KEY("practice_id","record_type","record_id")
);
--> statement-breakpoint
CREATE TABLE "pm_mock"."charges" (
	"id" text PRIMARY KEY NOT NULL,
	"encounter_id" text NOT NULL,
	"line_number" smallint NOT NULL,
	"code" text NOT NULL,
	"modifiers" text[] NOT NULL,
	"units" integer NOT NULL,
	"charge_cents" bigint NOT NULL,
	"pointers" smallint[] NOT NULL,
	"ndc" text
);
--> statement-breakpoint
CREATE TABLE "pm_mock"."claims" (
	"encounter_id" text PRIMARY KEY NOT NULL,
	"practice_id" text NOT NULL,
	"patient_control_number" text NOT NULL,
	"status" text NOT NULL,
	"rejection_reasons" text[] DEFAULT '{}' NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pm_mock"."encounters" (
	"id" text PRIMARY KEY NOT NULL,
	"practice_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"date_of_service" date NOT NULL,
	"rendering_npi" text NOT NULL,
	"referring_npi" text,
	"location_id" text NOT NULL,
	"place_of_service" text NOT NULL,
	"prior_auth_number" text,
	"diagnoses" jsonb NOT NULL,
	"status" text NOT NULL,
	"workflow_status" text,
	"on_hold" boolean DEFAULT false NOT NULL,
	"patient_control_number" text,
	"updated_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pm_mock"."locations" (
	"id" text PRIMARY KEY NOT NULL,
	"practice_id" text NOT NULL,
	"name" text NOT NULL,
	"place_of_service" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pm_mock"."patients" (
	"id" text PRIMARY KEY NOT NULL,
	"practice_id" text NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"dob" date NOT NULL,
	"sex" text NOT NULL,
	"address" jsonb,
	"phone" text,
	"updated_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pm_mock"."payments" (
	"id" text PRIMARY KEY NOT NULL,
	"practice_id" text NOT NULL,
	"payer_name" text,
	"trace_number" text NOT NULL,
	"method" text DEFAULT 'ACH' NOT NULL,
	"amount_cents" bigint NOT NULL,
	"payment_date" date NOT NULL,
	"header_only" boolean DEFAULT false NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_trace_key" UNIQUE("practice_id","trace_number")
);
--> statement-breakpoint
CREATE TABLE "pm_mock"."policies" (
	"id" text PRIMARY KEY NOT NULL,
	"practice_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"payer_name" text NOT NULL,
	"priority" smallint NOT NULL,
	"member_id" text NOT NULL,
	"group_number" text,
	"relationship" text NOT NULL,
	"subscriber" jsonb,
	"effective_date" date,
	"termination_date" date
);
--> statement-breakpoint
CREATE TABLE "pm_mock"."postings" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"practice_id" text NOT NULL,
	"payment_id" text NOT NULL,
	"encounter_id" text NOT NULL,
	"charge_id" text,
	"paid_cents" bigint NOT NULL,
	"adjustments" jsonb NOT NULL,
	"patient_resp_cents" bigint NOT NULL,
	"posted_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pm_mock"."practices" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"name" text NOT NULL,
	"specialty" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pm_mock"."providers" (
	"practice_id" text NOT NULL,
	"npi" text NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "providers_practice_id_npi_pk" PRIMARY KEY("practice_id","npi")
);
--> statement-breakpoint
CREATE TABLE "pm_mock"."remittances" (
	"id" text PRIMARY KEY NOT NULL,
	"practice_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pm_mock"."write_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"practice_id" text NOT NULL,
	"operation" text NOT NULL,
	"target" text NOT NULL,
	"result" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pm_mock"."adjustment_codes" ADD CONSTRAINT "adjustment_codes_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "pm_mock"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pm_mock"."charges" ADD CONSTRAINT "charges_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "pm_mock"."encounters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pm_mock"."claims" ADD CONSTRAINT "claims_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "pm_mock"."encounters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pm_mock"."claims" ADD CONSTRAINT "claims_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "pm_mock"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pm_mock"."encounters" ADD CONSTRAINT "encounters_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "pm_mock"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pm_mock"."encounters" ADD CONSTRAINT "encounters_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "pm_mock"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pm_mock"."encounters" ADD CONSTRAINT "encounters_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "pm_mock"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pm_mock"."locations" ADD CONSTRAINT "locations_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "pm_mock"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pm_mock"."patients" ADD CONSTRAINT "patients_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "pm_mock"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pm_mock"."payments" ADD CONSTRAINT "payments_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "pm_mock"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pm_mock"."policies" ADD CONSTRAINT "policies_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "pm_mock"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pm_mock"."policies" ADD CONSTRAINT "policies_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "pm_mock"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pm_mock"."postings" ADD CONSTRAINT "postings_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "pm_mock"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pm_mock"."postings" ADD CONSTRAINT "postings_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "pm_mock"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pm_mock"."postings" ADD CONSTRAINT "postings_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "pm_mock"."encounters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pm_mock"."postings" ADD CONSTRAINT "postings_charge_id_charges_id_fk" FOREIGN KEY ("charge_id") REFERENCES "pm_mock"."charges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pm_mock"."practices" ADD CONSTRAINT "practices_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "pm_mock"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pm_mock"."providers" ADD CONSTRAINT "providers_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "pm_mock"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pm_mock"."remittances" ADD CONSTRAINT "remittances_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "pm_mock"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "charges_encounter_idx" ON "pm_mock"."charges" USING btree ("encounter_id");--> statement-breakpoint
CREATE INDEX "claims_paging_idx" ON "pm_mock"."claims" USING btree ("practice_id","updated_at","encounter_id");--> statement-breakpoint
CREATE INDEX "encounters_paging_idx" ON "pm_mock"."encounters" USING btree ("practice_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "patients_paging_idx" ON "pm_mock"."patients" USING btree ("practice_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "postings_paging_idx" ON "pm_mock"."postings" USING btree ("practice_id","posted_at","id");