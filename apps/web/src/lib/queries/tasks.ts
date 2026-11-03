import 'server-only';
import { nowMs } from '@cleanpost/clock';
import { and, desc, eq, gte, inArray, ne, sql, type SQL } from 'drizzle-orm';
import { clients, connections, manualTasks, users, withTenant, workItems } from '@cleanpost/db';
import { policy } from '@cleanpost/domain';
import { getDb } from '../server';
import type { ActiveContext } from '../session';

const NONE = '00000000-0000-0000-0000-000000000000';

/** Estimated minutes a person spends per task, by operation (M-03: labeled as estimates). */
export const MINUTES_PER_TASK: Record<string, number> = {
  postPayment: 12,
  releaseCharge: 2,
  holdCharge: 1,
  markChargeBilled: 2,
  pushChargeCorrection: 5,
};

export interface TaskRow {
  id: string;
  workItemId: string | null;
  clientName: string;
  pmName: string;
  operation: string;
  title: string;
  status: string;
  assignee: string | null;
  createdAt: Date;
}

function scope(ctx: ActiveContext): SQL | undefined {
  const s = policy.clientFilter(ctx.actor);
  return s === 'all' ? undefined : inArray(manualTasks.clientId, s.length ? [...s] : [NONE]);
}

/** M-03: open manual work by client and operation, and the last 30 days by operation and PM. */
export async function listManualTasks(ctx: ActiveContext, filter: { clientId: string | null }) {
  return withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const base = [scope(ctx), filter.clientId ? eq(manualTasks.clientId, filter.clientId) : undefined];
    const rows = await tx
      .select({
        task: manualTasks,
        clientName: clients.name,
        settings: connections.settings,
        assignee: users.name,
      })
      .from(manualTasks)
      .innerJoin(clients, eq(clients.id, manualTasks.clientId))
      .innerJoin(connections, eq(connections.id, manualTasks.connectionId))
      .leftJoin(workItems, eq(workItems.id, manualTasks.workItemId))
      .leftJoin(users, eq(users.id, workItems.assigneeId))
      .where(and(...base, ne(manualTasks.status, 'done')))
      .orderBy(desc(sql`${manualTasks.status} = 'escalated'`), desc(manualTasks.createdAt))
      .limit(200);
    const since = new Date(nowMs() - 30 * 86_400_000);
    const recent = await tx
      .select({
        operation: manualTasks.operation,
        settings: connections.settings,
        n: sql<number>`count(*)::int`,
      })
      .from(manualTasks)
      .innerJoin(connections, eq(connections.id, manualTasks.connectionId))
      .where(and(...base, gte(manualTasks.createdAt, since)))
      .groupBy(manualTasks.operation, connections.settings);
    const pmOf = (s: unknown) => ((s ?? {}) as { pmName?: string }).pmName ?? 'PM';
    const byKey = new Map<string, { operation: string; pmName: string; count: number; minutes: number }>();
    for (const r of recent) {
      const key = `${r.operation}|${pmOf(r.settings)}`;
      const cur = byKey.get(key) ?? {
        operation: r.operation,
        pmName: pmOf(r.settings),
        count: 0,
        minutes: 0,
      };
      cur.count += r.n;
      cur.minutes += r.n * (MINUTES_PER_TASK[r.operation] ?? 5);
      byKey.set(key, cur);
    }
    return {
      rows: rows.map((r): TaskRow => ({
        id: r.task.id,
        workItemId: r.task.workItemId,
        clientName: r.clientName,
        pmName: pmOf(r.settings),
        operation: r.task.operation,
        title: r.task.title,
        status: r.task.status,
        assignee: r.assignee,
        createdAt: r.task.createdAt,
      })),
      last30: [...byKey.values()].sort((a, b) => b.minutes - a.minutes),
    };
  });
}
