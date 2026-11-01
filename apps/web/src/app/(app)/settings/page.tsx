import type { Metadata } from 'next';
import { policy } from '@cleanpost/domain';
import { NoAccess, NotBuiltYet } from '@/components/page';
import { requireActiveContext } from '@/lib/session';

export const metadata: Metadata = { title: 'Settings' };

export default async function Page() {
  const ctx = await requireActiveContext();
  if (!policy.authorize(ctx.actor, 'users.manage').allowed) return <NoAccess />;
  return (
    <NotBuiltYet title="Settings" view="S-01" milestone="M5">
      Users, automation thresholds, rules, mappings and branding are managed here.
    </NotBuiltYet>
  );
}
