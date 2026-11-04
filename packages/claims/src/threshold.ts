/**
 * The effective release threshold for a claim (S-04, DEC-23): client-payer override, else the
 * client's own number, else the company default, else 90; 100 through the client's "review everything
 * until" date. Read inside the caller's transaction.
 */
import { eq } from 'drizzle-orm';
import { now as clockNow } from '@cleanpost/clock';
import { tenants, type Tx } from '@cleanpost/db';
import { companyReleaseThreshold, effectiveReleaseThreshold } from '@cleanpost/domain';

export async function releaseThresholdFor(
  tx: Tx,
  tenantId: string,
  client: { autoReleaseThreshold: number | null; reviewUntil?: string | null; timezone?: string } | undefined,
  clientPayer: { autoReleaseThresholdOverride: number | null } | undefined,
): Promise<number> {
  const [t] = await tx.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, tenantId));
  return effectiveReleaseThreshold({
    clientPayer: clientPayer?.autoReleaseThresholdOverride ?? null,
    client: client?.autoReleaseThreshold ?? null,
    company: companyReleaseThreshold(t?.settings),
    reviewUntil: client?.reviewUntil ?? null,
    today: new Intl.DateTimeFormat('en-CA', { timeZone: client?.timezone ?? 'America/Los_Angeles' }).format(
      clockNow(),
    ),
  });
}
