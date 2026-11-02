/**
 * F-02 Posting worksheet as CSV, from a posting task (M-01). Contains patient account numbers and
 * dates of service (PHI): role and client scope checked, generation audited, never cached, and the
 * file name carries only the trace number.
 */
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { recordAudit, remittances, withTenant, workItems } from '@cleanpost/db';
import { policy, remit } from '@cleanpost/domain';
import { mappingLookupFor, POSTING_OPERATION, remittanceWorksheet } from '@cleanpost/remit';
import { getDb } from '@/lib/server';
import { requireActiveContext } from '@/lib/session';

export async function GET(_req: Request, { params }: { params: Promise<{ itemId: string }> }) {
  const ctx = await requireActiveContext();
  const id = z.uuid().safeParse((await params).itemId);
  if (!id.success) return new Response('Not found', { status: 404 });
  const out = await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const [item] = await tx
      .select()
      .from(workItems)
      .where(and(eq(workItems.id, id.data), eq(workItems.reasonCode, POSTING_OPERATION)));
    if (!item?.remittanceId || !item.clientId) return null;
    if (!policy.authorize(ctx.actor, 'payment.post', { clientId: item.clientId }).allowed)
      return 'forbidden' as const;
    const [r] = await tx.select().from(remittances).where(eq(remittances.id, item.remittanceId));
    const sheet = await remittanceWorksheet(tx, item.remittanceId, await mappingLookupFor(tx, item.clientId));
    await recordAudit(tx, {
      actor: `user:${ctx.user.id}`,
      action: 'worksheet.downloaded',
      entityType: 'work_item',
      entityId: item.id,
      clientId: item.clientId,
      metadata: { rows: sheet.rows.length, format: 'csv' },
    });
    return { csv: remit.worksheetCsv(sheet), trace: r?.traceNumber ?? 'payment' };
  });
  if (out === 'forbidden') return new Response('Forbidden', { status: 403 });
  if (!out) return new Response('Not found', { status: 404 });
  return new Response(
    `${out.csv}\r\n"Contains patient information. Keep it within the practice's systems."\r\n`,
    {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="posting-worksheet-${out.trace.replace(/[^A-Za-z0-9-]/g, '')}.csv"`,
        'cache-control': 'no-store',
      },
    },
  );
}
