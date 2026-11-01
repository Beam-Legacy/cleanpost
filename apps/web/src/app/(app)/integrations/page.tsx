import type { Metadata } from 'next';
import { policy } from '@cleanpost/domain';
import { NoAccess, NotBuiltYet } from '@/components/page';
import { requireActiveContext } from '@/lib/session';

export const metadata: Metadata = { title: 'Integrations' };

export default async function Page() {
  const ctx = await requireActiveContext();
  if (!policy.authorize(ctx.actor, 'integration.manage').allowed) return <NoAccess />;
  return (
    <NotBuiltYet title="Integrations" view="I-01" milestone="M1">
      Each client's PM connection appears here with what it can do and its sync history.
    </NotBuiltYet>
  );
}
