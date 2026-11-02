import 'server-only';
/**
 * The 270/271 client for a person's eligibility check (P-01, P-03, W-13): Stedi when the key is
 * set, else payer-sim in local and preview only. Null when neither is configured.
 */
import { createStediEligibilityClient, type EligibilityClient } from '@cleanpost/eligibility';
import { simConfig } from './sim';

export function eligibilityClient(): EligibilityClient | null {
  const key = process.env.STEDI_API_KEY;
  if (key)
    return createStediEligibilityClient({
      apiKey: key,
      ...(process.env.STEDI_BASE_URL ? { baseUrl: process.env.STEDI_BASE_URL } : {}),
    });
  const sim = simConfig();
  if (sim)
    return createStediEligibilityClient({
      apiKey: sim.payerSimToken ?? 'payer-sim',
      baseUrl: sim.payerSimUrl,
      kind: 'payer-sim',
      timeoutMs: 15_000,
    });
  return null;
}
