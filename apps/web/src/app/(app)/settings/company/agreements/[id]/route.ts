/**
 * S-14 Download an agreement (BAA, customer agreement): admins only, from the company's own files,
 * audited, never cached. The file name says what it is, nothing more.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { recordAudit, tenantAgreements, withTenant } from '@cleanpost/db';
import { policy } from '@cleanpost/domain';
import { readBlob } from '@cleanpost/documents';
import { getDb } from '@/lib/server';
import { getContext } from '@/lib/session';

const NO_STORE = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const FILE: Record<string, string> = {
  baa: 'business-associate-agreement',
  customer_agreement: 'customer-agreement',
};

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return new Response(null, { status: 404, headers: NO_STORE });
  const ctx = await getContext();
  if (ctx.status !== 'ok') return new Response(null, { status: 401, headers: NO_STORE });
  if (!policy.authorize(ctx.actor, 'users.manage').allowed)
    return new Response(null, { status: 403, headers: NO_STORE });
  const file = await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const [a] = await tx.select().from(tenantAgreements).where(eq(tenantAgreements.id, id));
    if (!a?.storageKey) return null;
    const blob = await readBlob(tx, a.storageKey);
    if (!blob) return null;
    await recordAudit(tx, {
      actor: `user:${ctx.user.id}`,
      action: 'agreement.downloaded',
      entityType: 'tenant_agreement',
      entityId: a.id,
      metadata: { type: a.type, version: a.version },
    });
    return { ...blob, name: `${FILE[a.type] ?? 'agreement'}-${a.version.replace(/[^\w.-]/g, '')}.pdf` };
  });
  if (!file) return new Response(null, { status: 404, headers: NO_STORE });
  return new Response(Buffer.from(file.bytes), {
    headers: {
      ...NO_STORE,
      'content-type': file.contentType,
      'content-disposition': `attachment; filename="${file.name}"`,
    },
  });
}
