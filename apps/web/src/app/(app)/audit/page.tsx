import type { Metadata } from 'next';
import { policy } from '@cleanpost/domain';
import { NoAccess, NotBuiltYet } from '@/components/page';
import { requireActiveContext } from '@/lib/session';

export const metadata: Metadata = { title: 'Audit log' };

export default async function Page() {
  const ctx = await requireActiveContext();
  if (!policy.authorize(ctx.actor, 'audit.view').allowed) return <NoAccess />;
  return (
    <NotBuiltYet title="Audit log" view="S-13" milestone="M5">
      Every view and change of patient information is recorded and searchable here.
    </NotBuiltYet>
  );
}
