/**
 * A document image (P-05, W-14) through a short-lived signed link, for the signed-in person it was
 * made for, inside their company and clients. Every view is audited; nothing is cached.
 */
import { z } from 'zod';
import { policy } from '@cleanpost/domain';
import { cardImage } from '@cleanpost/documents';
import { verifyDocumentUrl } from '@/lib/document-urls';
import { getDb } from '@/lib/server';
import { getContext } from '@/lib/session';

const NO_STORE = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return new Response(null, { status: 404, headers: NO_STORE });
  const ctx = await getContext();
  if (ctx.status !== 'ok') return new Response(null, { status: 401, headers: NO_STORE });
  const url = new URL(req.url);
  if (!verifyDocumentUrl(id, ctx.user.id, url.searchParams.get('e'), url.searchParams.get('s')))
    return new Response(null, { status: 403, headers: NO_STORE });
  const img = await cardImage(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id, documentId: id });
  if (!img || !policy.authorize(ctx.actor, 'patient.view', { clientId: img.clientId }).allowed)
    return new Response(null, { status: 404, headers: NO_STORE });
  return new Response(Buffer.from(img.bytes), {
    headers: { ...NO_STORE, 'content-type': img.contentType, 'content-disposition': 'inline' },
  });
}
