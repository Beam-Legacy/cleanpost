/** Eligibility words shared by P-01, P-03 and W-13 (server and client). */
import type { Status } from '@cleanpost/ui';

export const ELIGIBILITY_STATUS: Record<string, Status> = {
  active: 'Active',
  inactive: 'Inactive',
  error: 'Not confirmed',
  unknown: 'Not confirmed',
};

/** 271 AAA reject reasons the payer gives, in plain words (our wording, codes kept beside them). */
export const AAA_REASON: Record<string, string> = {
  '15': 'Required information missing',
  '41': 'Authorization or access restriction',
  '42': 'Payer unable to respond now',
  '43': 'Invalid or missing provider identification',
  '58': 'Date of birth does not match',
  '62': 'Date of service not within the allowable range',
  '71': "Date of birth does not match the payer's records",
  '72': 'Member ID not valid at this payer',
  '73': "Name does not match the payer's records",
  '75': 'Member not found at this payer',
  '76': 'Duplicate member ID',
};
