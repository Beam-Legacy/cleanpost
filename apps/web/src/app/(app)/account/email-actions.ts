'use server';
/**
 * A-09 Email: the person's own switches for the daily digest (E-04) and urgent alerts (E-05). Admins
 * still get connection and timely-filing emails (S-09 rules). Their own preference, so not audited.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { userPreferences, withTenant } from '@cleanpost/db';
import { getDb } from '@/lib/server';
import { requireActiveContext } from '@/lib/session';

const Input = z.object({ digestEmail: z.boolean(), alertEmail: z.boolean() });

export async function saveEmailPreferences(input: z.input<typeof Input>): Promise<{ ok: boolean }> {
  const ctx = await requireActiveContext();
  const v = Input.parse(input);
  await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, (tx) =>
    tx
      .insert(userPreferences)
      .values({ tenantId: ctx.tenantId, userId: ctx.user.id, ...v })
      .onConflictDoUpdate({
        target: [userPreferences.tenantId, userPreferences.userId],
        set: { ...v, updatedAt: new Date() },
      }),
  );
  revalidatePath('/account');
  return { ok: true };
}
