CREATE TABLE "pm_mock"."clearinghouse_state" (
	"practice_id" text PRIMARY KEY NOT NULL,
	"acks_since" timestamp (3) with time zone
);
--> statement-breakpoint
ALTER TABLE "pm_mock"."clearinghouse_state" ADD CONSTRAINT "clearinghouse_state_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "pm_mock"."practices"("id") ON DELETE no action ON UPDATE no action;