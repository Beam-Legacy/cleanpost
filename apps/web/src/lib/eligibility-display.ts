/** Eligibility words shared by P-01, P-03 and W-13 (server and client). */
import type { Status } from '@cleanpost/ui';

export const ELIGIBILITY_STATUS: Record<string, Status> = {
  active: 'Active',
  inactive: 'Inactive',
  error: 'Not confirmed',
  unknown: 'Not confirmed',
};
