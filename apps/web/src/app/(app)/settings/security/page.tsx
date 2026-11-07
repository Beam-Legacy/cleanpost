import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { clientIp } from '@cleanpost/auth';
import { policy } from '@cleanpost/domain';
import { NoAccess } from '@/components/page';
import { securityPage } from '@/lib/queries/company';
import { requireActiveContext } from '@/lib/session';
import { SecurityForm } from './security-form';

export const metadata: Metadata = { title: 'Security' };

/**
 * S-12 Security (DEC-34): how people sign in to this company, how long sessions last, where from,
 * and who may export patient-level data. Floors that cannot be lowered: two-factor always, at most
 * 30 idle minutes, at most 12 hours.
 */
export default async function SecurityPage() {
  const ctx = await requireActiveContext();
  if (!policy.authorize(ctx.actor, 'security.manage').allowed) return <NoAccess />;
  const s = await securityPage(ctx);
  return (
    <SecurityForm
      settings={s.settings}
      passkeyOnly={s.passkeyOnly}
      stepUpWith={s.stepUpWith}
      address={clientIp(await headers())}
      tenantId={ctx.tenantId}
    />
  );
}
