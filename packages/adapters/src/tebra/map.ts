/**
 * Tebra -> external records. Pure functions, tested with fixtures shaped like Tebra's schema; to be
 * re-checked against recorded responses in the Tebra test (docs/16-milestones.md).
 */
import { parseDollarsToCents } from '@cleanpost/domain';
import type { ExtClaimStatus, ExtPosting } from '../contract';
import type { TebraChargeData } from './types';

const money = (v: string | undefined): number => (v ? (parseDollarsToCents(v) ?? 0) : 0);

/**
 * What Tebra posted for one charge line from its primary insurance (pullPostings). Adjustment codes
 * use Tebra's own reason text, prefixed by the kind, so adjustment_mappings can translate them.
 * Returns null when nothing has been posted from the primary payer.
 */
export function mapChargeToPosting(row: TebraChargeData): ExtPosting | null {
  if (!row.PrimaryInsurancePaymentRef && !row.PrimaryInsuranceInsurancePayment) return null;
  const adjustments: ExtPosting['adjustments'] = [];
  const contract = money(row.PrimaryInsuranceInsuranceContractAdjustment);
  if (contract)
    adjustments.push({
      pmAdjustmentCode: `CONTRACT:${row.PrimaryInsuranceInsuranceContractAdjustmentReason ?? ''}`,
      amountCents: contract,
    });
  const other = money(row.PrimaryInsuranceInsuranceSecondaryAdjustment);
  if (other)
    adjustments.push({
      pmAdjustmentCode: `OTHER:${row.PrimaryInsuranceInsuranceSecondaryAdjustmentReason ?? ''}`,
      amountCents: other,
    });
  const patientResp =
    money(row.PrimaryInsuranceInsuranceDeductible) +
    money(row.PrimaryInsuranceInsuranceCoinsurance) +
    money(row.PrimaryInsuranceInsuranceCopay);
  return {
    traceNumber: row.PrimaryInsurancePaymentRef ?? '',
    encounterExternalId: row.EncounterID,
    lineExternalId: row.EncounterProcedureID,
    paidCents: money(row.PrimaryInsuranceInsurancePayment),
    adjustments,
    patientRespCents: patientResp,
    postedAt: row.PrimaryInsurancePaymentPostingDate || row.LastModifiedDate,
  };
}

const STATUS: Record<string, ExtClaimStatus['status']> = {
  Completed: 'paid',
  Pending: 'sent',
  Ready: 'queued',
  'Error – Rejection': 'rejected',
  'Error - Rejection': 'rejected',
  'Error – Denial': 'denied',
  'Error - Denial': 'denied',
  'Error – No Response': 'sent',
  'Error - No Response': 'sent',
};

/** Coarse claim status per encounter (pullClaimsAndStatus). */
export function mapChargeToClaimStatus(row: TebraChargeData): ExtClaimStatus {
  return {
    encounterExternalId: row.EncounterID,
    status: STATUS[row.Status] ?? 'unknown',
    updatedAt: row.LastModifiedDate,
  };
}
