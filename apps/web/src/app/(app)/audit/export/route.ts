/**
 * F-03 / S-13 audit export: the filtered events as CSV for a compliance request. Admins only; the
 * export itself is recorded. Audit metadata never holds patient data (packages/db audit).
 */
import { now as clockNow } from '@cleanpost/clock';
import { recordAudit, withTenant } from '@cleanpost/db';
import { policy, reports } from '@cleanpost/domain';
import { actionLabel, auditFilters, detailsOf, recordLabel } from '@/lib/audit-display';
import { AUDIT_EXPORT_CAP, listAudit } from '@/lib/queries/settings';
import { getDb } from '@/lib/server';
import { requireActiveContext } from '@/lib/session';

export async function GET(req: Request) {
  const ctx = await requireActiveContext();
  if (!policy.authorize(ctx.actor, 'audit.view').allowed) return new Response('Forbidden', { status: 403 });
  const f = { ...auditFilters(Object.fromEntries(new URL(req.url).searchParams)), page: 1 };
  const now = clockNow();
  const { rows, total } = await listAudit(ctx, f, now, AUDIT_EXPORT_CAP);
  const csv = reports.toCsv(
    [
      'When (UTC)',
      'Who',
      'Actor',
      'Action',
      'Action code',
      'Record',
      'Record ID',
      'Client',
      'Details',
      'IP address',
    ],
    rows.map((r) => [
      r.at.toISOString(),
      r.who,
      r.actor,
      actionLabel(r.action),
      r.action,
      recordLabel(r.entityType),
      r.entityId,
      r.clientName,
      detailsOf(r.metadata),
      r.ip,
    ]),
    [
      `Audit log export, last ${f.days} ${f.days === 1 ? 'day' : 'days'} to ${now.toISOString()}`,
      total > rows.length
        ? `First ${rows.length} of ${total} events; narrow the filters for the rest.`
        : `${total} events.`,
    ],
  );
  await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, (tx) =>
    recordAudit(tx, {
      actor: `user:${ctx.user.id}`,
      action: 'audit.exported',
      entityType: 'tenant',
      entityId: ctx.tenantId,
      metadata: {
        rows: rows.length,
        days: f.days,
        format: 'csv',
        filtered: Boolean(f.who || f.action || f.record || f.id),
      },
    }),
  );
  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="cleanpost-audit-${now.toISOString().slice(0, 10)}.csv"`,
      'cache-control': 'no-store',
    },
  });
}
