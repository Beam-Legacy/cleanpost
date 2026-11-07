'use server';
/**
 * S-14 Company profile (DEC-34): names, address, phone, time zone and the contacts Cleanpost must
 * reach. The security contact is required (it receives incident notices under the BAA). Admins only;
 * audited with the names of the fields that changed, never their values.
 */
import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { recordAudit, tenants, withTenant } from '@cleanpost/db';
import { company, policy } from '@cleanpost/domain';
import { getDb } from '@/lib/server';
import { requireActiveContext } from '@/lib/session';

export type ProfileErrors = Partial<
  Record<
    | 'legalName'
    | 'name'
    | 'address'
    | 'phone'
    | 'timezone'
    | 'securityName'
    | 'securityEmail'
    | 'billingName'
    | 'billingEmail',
    string
  >
>;

export interface ProfileResult {
  ok: boolean;
  message: string;
  errors?: ProfileErrors;
}

const FIELD: Record<string, keyof ProfileErrors> = {
  'securityContact.name': 'securityName',
  'securityContact.email': 'securityEmail',
  'billingContact.name': 'billingName',
  'billingContact.email': 'billingEmail',
};

export async function saveCompanyProfile(input: company.ProfileInput): Promise<ProfileResult> {
  const ctx = await requireActiveContext();
  policy.assertAllowed(ctx.actor, 'users.manage');
  const parsed = company.profileSchema.safeParse(input);
  if (!parsed.success) {
    const errors: ProfileErrors = {};
    for (const issue of parsed.error.issues) {
      const path = issue.path.join('.');
      const key = (FIELD[path] ?? path) as keyof ProfileErrors;
      errors[key] ??= key === 'timezone' ? 'Choose a time zone.' : issue.message;
    }
    return { ok: false, message: 'Check the highlighted fields.', errors };
  }
  const v = parsed.data;
  return withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const [t] = await tx.select().from(tenants).where(eq(tenants.id, ctx.tenantId)).for('update');
    if (!t) return { ok: false, message: 'Company not found.' };
    const next = {
      legalName: v.legalName,
      name: v.name,
      address: v.address ? { line: v.address } : null,
      phone: v.phone || null,
      timezone: v.timezone,
      securityContact: v.securityContact,
      billingContact: v.billingContact,
    };
    const before: Record<keyof typeof next, unknown> = {
      legalName: t.legalName,
      name: t.name,
      address: t.address,
      phone: t.phone,
      timezone: t.timezone,
      securityContact: company.readContact(t.securityContact),
      billingContact: company.readContact(t.billingContact),
    };
    const changed = (Object.keys(next) as (keyof typeof next)[]).filter(
      (k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(next[k] ?? null),
    );
    if (!changed.length) return { ok: true, message: 'Nothing to save.' };
    await tx
      .update(tenants)
      .set({ ...next, updatedAt: new Date() })
      .where(eq(tenants.id, ctx.tenantId));
    await recordAudit(tx, {
      actor: `user:${ctx.user.id}`,
      action: 'company.profile_updated',
      entityType: 'tenant',
      entityId: ctx.tenantId,
      // Which fields, not what they hold: contacts are people's details.
      metadata: { fields: changed },
    });
    revalidatePath('/', 'layout');
    return { ok: true, message: 'Company profile saved.' };
  });
}
