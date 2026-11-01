'use server';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { chooseCompany } from '@cleanpost/auth';
import { recordAudit, withTenant } from '@cleanpost/db';
import { getDb } from '@/lib/server';
import { getContext } from '@/lib/session';

const Input = z.object({ tenantId: z.uuid() });

/** A-07: switches the session to a company the user belongs to, and audits the switch. */
export async function chooseCompanyAction(formData: FormData) {
  const ctx = await getContext();
  if (ctx.status !== 'choose_company' && ctx.status !== 'ok') redirect('/sign-in');
  const { tenantId } = Input.parse({ tenantId: formData.get('tenantId') });
  const db = getDb();
  await chooseCompany(db, ctx.sessionId, ctx.user.id, tenantId);
  await withTenant(db, { tenantId, userId: ctx.user.id }, (tx) =>
    recordAudit(tx, {
      actor: `user:${ctx.user.id}`,
      action: 'session.company_chosen',
      entityType: 'tenant',
      entityId: tenantId,
    }),
  );
  redirect('/work');
}
