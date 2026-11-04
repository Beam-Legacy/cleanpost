import type { ReactNode } from 'react';
import { policy } from '@cleanpost/domain';
import { NoAccess } from '@/components/page';
import { requireActiveContext } from '@/lib/session';
import { SettingsNav } from './settings-nav';

/** Settings (S-01 to S-14): admins and the owner only; every change is audited. */
export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const ctx = await requireActiveContext();
  if (!policy.authorize(ctx.actor, 'users.manage').allowed) return <NoAccess />;
  return (
    <>
      <div className="page-head">
        <h1>Settings</h1>
      </div>
      <div className="split settings-split">
        <SettingsNav />
        <div className="split-main stack">{children}</div>
      </div>
    </>
  );
}
