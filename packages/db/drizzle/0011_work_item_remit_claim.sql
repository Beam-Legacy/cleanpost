ALTER TABLE "work_items" ADD COLUMN "remit_claim_id" uuid;--> statement-breakpoint
-- Existing unmatched-payment items: the payment they name (by remittance and control number).
UPDATE "work_items" wi SET "remit_claim_id" = rc."id"
FROM "remit_claims" rc
WHERE wi."type" = 'remit_unmatched' AND wi."remit_claim_id" IS NULL
  AND rc."remittance_id" = wi."remittance_id" AND rc."claim_id" IS NULL
  AND wi."summary" LIKE '%control number ' || rc."patient_control_number" || ' %';
