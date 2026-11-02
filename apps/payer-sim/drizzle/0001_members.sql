CREATE TABLE "payer_sim"."members" (
	"payer_id" text NOT NULL,
	"member_id" text NOT NULL,
	"date_of_birth" text NOT NULL,
	"status" text NOT NULL,
	"plan_begin" text,
	"plan_end" text,
	"copay_cents" integer,
	"deductible_remaining_cents" integer,
	"coinsurance_percent" integer,
	CONSTRAINT "members_payer_id_member_id_pk" PRIMARY KEY("payer_id","member_id")
);
