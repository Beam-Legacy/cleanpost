import 'server-only';
import { and, asc, count, eq, inArray, ne, type SQL } from 'drizzle-orm';
import { clients, connections, withTenant, workItems } from '@cleanpost/db';
import { policy } from '@cleanpost/domain';
import { getDb } from '../server';
import type { ActiveContext } from '../session';

export interface ClientRow {
  id: string;
  name: string;
  status: 'onboarding' | 'live' | 'paused' | 'offboarded';
  mode: 'A' | 'B' | 'C';
  pmName: string;
  connectionId: string | null;
  connectionStatus: string | null;
  openItems: number;
  onboardingStep: number | null;
}

/** CL-01: clients in the caller's scope, with their connection and open work. */
export async function listClients(ctx: ActiveContext): Promise<ClientRow[]> {
  const scope = policy.clientFilter(ctx.actor);
  return withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const where: SQL[] = [ne(clients.status, 'offboarded')];
    if (scope !== 'all')
      where.push(inArray(clients.id, scope.length ? [...scope] : ['00000000-0000-0000-0000-000000000000']));
    const rows = await tx
      .select({
        id: clients.id,
        name: clients.name,
        status: clients.status,
        mode: clients.defaultMode,
        connectionId: connections.id,
        connectionStatus: connections.status,
        settings: connections.settings,
      })
      .from(clients)
      .leftJoin(connections, eq(connections.clientId, clients.id))
      .where(and(...where))
      .orderBy(asc(clients.name));
    const open = await tx
      .select({ clientId: workItems.clientId, n: count() })
      .from(workItems)
      .where(ne(workItems.status, 'resolved'))
      .groupBy(workItems.clientId);
    return rows.map((r) => {
      const settings = (r.settings ?? {}) as { pmName?: string; onboardingStep?: number };
      return {
        id: r.id,
        name: r.name,
        status: r.status as ClientRow['status'],
        mode: r.mode as ClientRow['mode'],
        pmName: settings.pmName ?? '—',
        connectionId: r.connectionId,
        connectionStatus: r.connectionStatus,
        openItems: open.find((o) => o.clientId === r.id)?.n ?? 0,
        onboardingStep: settings.onboardingStep ?? null,
      };
    });
  });
}
