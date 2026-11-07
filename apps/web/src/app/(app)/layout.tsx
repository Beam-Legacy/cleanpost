import { asc, eq, inArray, type SQL } from 'drizzle-orm';
import type { ReactNode } from 'react';
import { listCompanies } from '@cleanpost/auth';
import { getOffset } from '@cleanpost/clock';
import { clients, tenants, withTenant } from '@cleanpost/db';
import { policy } from '@cleanpost/domain';
import { TooltipProvider, ToastProvider } from '@cleanpost/ui';
import { AppShell } from '@/components/app-shell';
import { unreadNotificationCount } from './notification-actions';
import { ClockOffset } from '@/components/clock-offset';
import { getDb } from '@/lib/server';
import { requireActiveContext } from '@/lib/session';

/** Every app page: requires a signed-in user with a second factor and a chosen company. */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const ctx = await requireActiveContext();
  const db = getDb();
  const scope = policy.clientFilter(ctx.actor);
  const { tenantName, clientList } = await withTenant(
    db,
    { tenantId: ctx.tenantId, userId: ctx.user.id },
    async (tx) => {
      const [t] = await tx.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, ctx.tenantId));
      const where: SQL | undefined =
        scope === 'all'
          ? undefined
          : inArray(clients.id, scope.length ? [...scope] : ['00000000-0000-0000-0000-000000000000']);
      const rows = await tx
        .select({ id: clients.id, name: clients.name, status: clients.status })
        .from(clients)
        .where(where)
        .orderBy(asc(clients.name));
      return { tenantName: t?.name ?? '', clientList: rows.filter((c) => c.status !== 'offboarded') };
    },
  );
  const companyCount = (await listCompanies(db, ctx.user.id)).length;
  const allowedNav = policy.ACTIONS.filter((a) => policy.authorize(ctx.actor, a).allowed);
  const unread = await unreadNotificationCount();

  return (
    <TooltipProvider>
      <ToastProvider>
        <ClockOffset ms={getOffset()} />
        <AppShell
          user={{ name: ctx.user.name, role: ctx.actor.role, isOwner: ctx.actor.isOwner }}
          tenantName={tenantName}
          clients={clientList}
          allowedActions={allowedNav}
          canSwitchCompany={companyCount > 1}
          unreadNotifications={unread}
          idleMinutes={ctx.idleMinutes}
        >
          {children}
        </AppShell>
      </ToastProvider>
    </TooltipProvider>
  );
}
