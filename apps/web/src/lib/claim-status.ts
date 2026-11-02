import 'server-only';
/**
 * The 276/277 client for a person's status check (C-15, W-15): Stedi when the key is set, else
 * payer-sim in local and preview only (Stedi's test keys do not cover claim status). Null when
 * neither is configured: the screens say status checks are not set up.
 */
import { createStediClaimStatusClient, type ClaimStatusClient } from '@cleanpost/eligibility';
import { simConfig } from './sim';

export function claimStatusClient(): ClaimStatusClient | null {
  const key = process.env.STEDI_API_KEY;
  if (key)
    return createStediClaimStatusClient({
      apiKey: key,
      ...(process.env.STEDI_BASE_URL ? { baseUrl: process.env.STEDI_BASE_URL } : {}),
    });
  const sim = simConfig();
  if (sim)
    return createStediClaimStatusClient({
      apiKey: sim.payerSimToken ?? 'payer-sim',
      baseUrl: sim.payerSimUrl,
      kind: 'payer-sim',
    });
  return null;
}
