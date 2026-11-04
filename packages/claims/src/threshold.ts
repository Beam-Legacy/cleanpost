/**
 * The effective release threshold for a claim (S-04, DEC-23): client-payer override, else the
 * client's own number, else the company default, else 90. Read inside the caller's transaction.
 */
import { eq } from 'drizzle-orm';
import { tenants, type Tx } from '@cleanpost/db';
import { companyReleaseThreshold, effectiveReleaseThreshold } from '@cleanpost/domain';

export async function releaseThresholdFor(
  tx: Tx,
  tenantId: string,
  client: { autoReleaseThreshold: number | null } | undefined,
  clientPayer: { autoReleaseThresholdOverride: number | null } | undefined,
): Promise<number> {
  const [t] = await tx.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, tenantId));
  return effectiveReleaseThreshold({
    clientPayer: clientPayer?.autoReleaseThresholdOverride ?? null,
    client: client?.autoReleaseThreshold ?? null,
    company: companyReleaseThreshold(t?.settings),
  });
}
