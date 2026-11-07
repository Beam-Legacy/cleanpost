/**
 * The company's report logo (S-10, F-01), for anyone signed in to the company. An SVG is served
 * under a sandboxing policy, so even opened on its own nothing in it runs.
 */
import { readBlob } from '@cleanpost/documents';
import { withTenant } from '@cleanpost/db';
import { companyBranding } from '@/lib/queries/company';
import { getDb } from '@/lib/server';
import { getContext } from '@/lib/session';

const HEADERS = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
};

export async function GET() {
  const ctx = await getContext();
  if (ctx.status !== 'ok')
    return new Response(null, { status: 401, headers: { 'cache-control': 'no-store' } });
  const { branding } = await companyBranding(ctx);
  const logo = branding.logo;
  const blob = logo
    ? await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, (tx) =>
        readBlob(tx, logo.storageKey),
      )
    : null;
  if (!logo || !blob) return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
  return new Response(Buffer.from(blob.bytes), {
    headers: {
      ...HEADERS,
      'content-type': logo.contentType,
      'content-disposition': 'inline',
      'cache-control': 'private, max-age=300',
    },
  });
}
