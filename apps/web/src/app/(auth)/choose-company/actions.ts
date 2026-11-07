'use server';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { chooseCompany, clientIp, forgetTrustedDevices } from '@cleanpost/auth';
import { recordAudit, withTenant } from '@cleanpost/db';
import { getDb } from '@/lib/server';
import { getContext } from '@/lib/session';

const Input = z.object({ tenantId: z.uuid() });

/**
 * A-07: switches the session to a company the user belongs to, and audits the switch. A company
 * whose S-12 settings turn this session away is not entered: A-07 says why (DEC-34).
 */
export async function chooseCompanyAction(formData: FormData) {
  const ctx = await getContext();
  if (ctx.status !== 'choose_company' && ctx.status !== 'ok' && ctx.status !== 'company_blocked')
    redirect('/sign-in');
  const { tenantId } = Input.parse({ tenantId: formData.get('tenantId') });
  const db = getDb();
  const blocked = await chooseCompany(db, ctx.sessionId, ctx.user.id, tenantId, clientIp(await headers()));
  if (blocked) redirect(`/choose-company?blocked=${blocked}&company=${tenantId}`);
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

/**
 * A-07 "Sign in with your code": a company that does not accept trusted devices asks for the code,
 * so this device stops skipping it (the client signs out next).
 */
export async function forgetThisDeviceAction(): Promise<void> {
  const ctx = await getContext();
  if (ctx.status === 'signed_out') return;
  await forgetTrustedDevices(getDb(), ctx.user.id);
}
