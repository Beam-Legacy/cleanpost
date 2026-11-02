/**
 * A 277 in the shape of Stedi's real-time claim status JSON (POST
 * /2024-04-01/change/medicalnetwork/claimstatus/v2), answered from what this payer received and
 * decided, so Cleanpost's client works against payer-sim now and against Stedi in production
 * (Stedi's test keys do not cover claim status). Codes from the X12 claim status category (507)
 * and status (508) lists:
 *
 * - not on file: A4 / 35 (claim not found)
 * - rejected at the front end: A3 with the 277CA status code
 * - in process: P1 / 20 (accepted for processing); one claim in ten (by its number) waits for
 *   records the payer asked for: P3 / 21 (missing or invalid information)
 * - decided and in a payment run: F1 / 65 (paid) or F2 / 1 (denied: see the remittance advice),
 *   with the 835's trace number and date
 *
 * Request and response carry PHI (member ID, names): never logged.
 */
import { z } from 'zod';
import type { remit } from '@cleanpost/domain';
import type { SubmittedClaim } from './ack';
import { payerClaimNumber } from './adjudicate';
import { hash } from './payers';

const ymd8 = /^\d{8}$/;

export const claimStatusRequestSchema = z.object({
  controlNumber: z.string().max(9).optional(),
  tradingPartnerServiceId: z.string().min(1),
  providers: z
    .array(
      z.object({
        providerType: z.enum(['BillingProvider', 'ServiceProvider']),
        npi: z.string().optional(),
        organizationName: z.string().optional(),
      }),
    )
    .min(1),
  subscriber: z.object({
    memberId: z.string().min(1),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    dateOfBirth: z.string().regex(ymd8).optional(),
  }),
  encounter: z.object({
    beginningDateOfService: z.string().regex(ymd8),
    endDateOfService: z.string().regex(ymd8),
  }),
});
export type ClaimStatusRequest = z.infer<typeof claimStatusRequestSchema>;

/** What the payer has for one submission, as payer-sim stores it. */
export interface StatusRow {
  patientControlNumber: string;
  payerId: string;
  claim: SubmittedClaim;
  ackStatus: string;
  ackDueAt: Date;
  ackCodes: string[];
  adjudication: remit.ClaimPayment | null;
  remittance: { traceNumber: string; paymentDate: string } | null;
}

const CATEGORY: Record<string, string> = {
  A3: 'Acknowledgement/Returned as unprocessable claim',
  A4: 'Acknowledgement/Not Found',
  P1: 'Pending/In Process',
  P3: 'Pending/Provider Requested Information',
  F1: 'Finalized/Payment-The claim/line has been paid.',
  F2: 'Finalized/Denial-The claim/line has been denied.',
};
const STATUS: Record<string, string> = {
  '1': 'For more detailed information, see remittance advice.',
  '20': 'Accepted for processing.',
  '21': 'Missing or invalid information.',
  '35': 'Claim/encounter not found.',
  '65': 'Claim/line has been paid.',
};

const money = (cents: number) => (cents / 100).toFixed(2);
const day = (d: Date) => d.toISOString().slice(0, 10);
const toYmd8 = (iso: string) => iso.replaceAll('-', '');

/** One claim in ten waits for records the payer asked for, by its patient control number. */
export const pendsForRecords = (pcn: string) => hash(`records:${pcn}`) % 10 === 0;

function status(category: string, code: string, effectiveDate: string) {
  return {
    statusCategoryCode: category,
    statusCategoryCodeValue: CATEGORY[category] ?? category,
    statusCode: code,
    statusCodeValue: STATUS[code] ?? code,
    entityCode: '41',
    entity: 'Submitter',
    effectiveDate,
  };
}

export function respond277(req: ClaimStatusRequest, rows: StatusRow[], now: Date) {
  const begin = req.encounter.beginningDateOfService;
  const end = req.encounter.endDateOfService;
  const npi = req.providers.find((p) => p.providerType === 'BillingProvider')?.npi;
  const mine = rows.filter((r) => {
    const dos = toYmd8(r.claim.dateOfService);
    return dos >= begin && dos <= end && (!npi || !r.claim.billingNpi || r.claim.billingNpi === npi);
  });
  // The payer has a claim once its front end has answered (the 277CA time).
  const known = mine.filter((r) => r.ackDueAt.getTime() <= now.getTime());
  const base = {
    controlNumber: req.controlNumber ?? String(100_000_000 + (hash(`${begin}${end}`) % 900_000_000)),
    tradingPartnerServiceId: req.tradingPartnerServiceId,
    payer: { name: 'PAYER-SIM', payorIdentification: req.tradingPartnerServiceId },
    status: 'SUCCESS',
  };
  if (!known.length) return { ...base, claims: [{ claimStatus: status('A4', '35', day(now)) }] };

  return {
    ...base,
    claims: known.map((r) => {
      const c = r.claim;
      const common = {
        patientAccountNumber: r.patientControlNumber,
        tradingPartnerClaimNumber: payerClaimNumber(r.payerId, r.patientControlNumber),
        claimServiceDate: toYmd8(c.dateOfService),
        submittedAmount: money(c.totalChargeCents),
      };
      if (r.ackStatus !== 'accepted') {
        const code = r.ackCodes[0]?.split(':')[1] ?? '21';
        return { claimStatus: { ...status('A3', code, day(r.ackDueAt)), ...common, amountPaid: '0' } };
      }
      if (r.adjudication && r.remittance) {
        const p = r.adjudication;
        const denied = p.statusCode === '4';
        return {
          claimStatus: {
            ...status(denied ? 'F2' : 'F1', denied ? '1' : '65', r.remittance.paymentDate),
            ...common,
            amountPaid: money(p.paidCents),
            paidDate: r.remittance.paymentDate,
            checkNumber: r.remittance.traceNumber,
            checkIssueDate: r.remittance.paymentDate,
          },
        };
      }
      const records = pendsForRecords(r.patientControlNumber);
      return {
        claimStatus: {
          ...status(records ? 'P3' : 'P1', records ? '21' : '20', day(r.ackDueAt)),
          ...common,
          amountPaid: '0',
        },
      };
    }),
  };
}
