'use server';
/**
 * S-10 Branding (DEC-34): how client reports look to the practices. The name, contact line, footer
 * note and the Cleanpost credit (off unless turned on); the logo, a PNG at least 200 px wide or a
 * plain SVG, kept with the company's files. Admins only; audited.
 */
import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { recordAudit, tenants, withTenant, type Tx } from '@cleanpost/db';
import { company, policy } from '@cleanpost/domain';
import { deleteBlob, putBlob } from '@cleanpost/documents';
import { getDb } from '@/lib/server';
import { requireActiveContext, type ActiveContext } from '@/lib/session';

export interface BrandingResult {
  ok: boolean;
  message: string;
}

async function withBranding(
  ctx: ActiveContext,
  fn: (tx: Tx, settings: Record<string, unknown>, current: company.Branding) => Promise<BrandingResult>,
) {
  return withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const [t] = await tx
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, ctx.tenantId))
      .for('update');
    const settings = (t?.settings ?? {}) as Record<string, unknown>;
    return fn(tx, settings, company.branding(settings));
  });
}

async function store(
  tx: Tx,
  tenantId: string,
  settings: Record<string, unknown>,
  branding: company.Branding,
) {
  await tx
    .update(tenants)
    .set({ settings: { ...settings, branding }, updatedAt: new Date() })
    .where(eq(tenants.id, tenantId));
}

export async function saveBranding(input: company.BrandingInput): Promise<BrandingResult> {
  const ctx = await requireActiveContext();
  policy.assertAllowed(ctx.actor, 'users.manage');
  const parsed = company.brandingInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'Shorten the highlighted text, then save again.' };
  const v = parsed.data;
  return withBranding(ctx, async (tx, settings, current) => {
    const next: company.Branding = {
      ...current,
      reportName: v.reportName || null,
      contactLine: v.contactLine || null,
      footerNote: v.footerNote || null,
      showCredit: v.showCredit,
    };
    const fields = (['reportName', 'contactLine', 'footerNote', 'showCredit'] as const).filter(
      (k) => current[k] !== next[k],
    );
    if (!fields.length) return { ok: true, message: 'Nothing to save.' };
    await store(tx, ctx.tenantId, settings, next);
    await recordAudit(tx, {
      actor: `user:${ctx.user.id}`,
      action: 'branding.updated',
      entityType: 'tenant',
      entityId: ctx.tenantId,
      metadata: { fields },
    });
    revalidatePath('/settings/branding');
    return { ok: true, message: 'Branding saved. Client reports use it from now on.' };
  });
}

/** The file's type from its bytes (a PNG signature, or an SVG document), never from its name. */
function sniff(bytes: Uint8Array): string {
  if (company.pngSize(bytes)) return 'image/png';
  const head = new TextDecoder().decode(bytes.slice(0, 1024)).trimStart();
  return /^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)
    ? 'image/svg+xml'
    : 'unknown';
}

export async function uploadLogo(form: FormData): Promise<BrandingResult> {
  const ctx = await requireActiveContext();
  policy.assertAllowed(ctx.actor, 'users.manage');
  const file = form.get('logo');
  if (!(file instanceof File)) return { ok: false, message: 'Choose a logo file.' };
  if (file.size > company.LOGO_MAX_BYTES) return { ok: false, message: 'Use a logo under 1 MB.' };
  const bytes = new Uint8Array(await file.arrayBuffer());
  const check = company.checkLogo(sniff(bytes), bytes);
  if (!check.ok) return { ok: false, message: check.message };
  return withBranding(ctx, async (tx, settings, current) => {
    const key = `branding/logo/${randomUUID()}`;
    await putBlob(tx, {
      tenantId: ctx.tenantId,
      clientId: null,
      key,
      contentType: check.contentType,
      bytes,
    });
    if (current.logo) await deleteBlob(tx, current.logo.storageKey);
    await store(tx, ctx.tenantId, settings, {
      ...current,
      logo: { storageKey: key, contentType: check.contentType, width: check.width, height: check.height },
    });
    await recordAudit(tx, {
      actor: `user:${ctx.user.id}`,
      action: 'branding.logo_replaced',
      entityType: 'tenant',
      entityId: ctx.tenantId,
      metadata: { contentType: check.contentType, width: check.width, bytes: bytes.length },
    });
    revalidatePath('/settings/branding');
    return { ok: true, message: 'Logo saved.' };
  });
}

export async function removeLogo(): Promise<BrandingResult> {
  const ctx = await requireActiveContext();
  policy.assertAllowed(ctx.actor, 'users.manage');
  return withBranding(ctx, async (tx, settings, current) => {
    if (!current.logo) return { ok: true, message: 'No logo to remove.' };
    await deleteBlob(tx, current.logo.storageKey);
    await store(tx, ctx.tenantId, settings, { ...current, logo: null });
    await recordAudit(tx, {
      actor: `user:${ctx.user.id}`,
      action: 'branding.logo_removed',
      entityType: 'tenant',
      entityId: ctx.tenantId,
    });
    revalidatePath('/settings/branding');
    return { ok: true, message: 'Logo removed. Reports show the company name instead.' };
  });
}
