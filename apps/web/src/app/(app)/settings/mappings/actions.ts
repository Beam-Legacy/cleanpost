'use server';
/**
 * S-08: save a company-wide mapping for one PM type. Closes the "map this code" items it answers and
 * checks the waiting lines again (packages/remit). Denial codes are refused. Audited.
 */
import { revalidatePath } from 'next/cache';
import { withTenant } from '@cleanpost/db';
import { policy } from '@cleanpost/domain';
import { createLogger } from '@cleanpost/log';
import { pmTypeMappingInputSchema, savePmTypeMapping } from '@cleanpost/remit';
import { getDb } from '@/lib/server';
import { requireActiveContext } from '@/lib/session';

const log = createLogger({ name: 'web-mappings' });

export interface MappingActionResult {
  ok: boolean;
  message: string;
}

export async function saveCompanyMapping(input: {
  pmType: string;
  groupCode: string;
  carc: string;
  pmAdjustmentCode: string;
  action: string;
}): Promise<MappingActionResult> {
  const ctx = await requireActiveContext();
  policy.assertAllowed(ctx.actor, 'mappings.manage');
  const parsed = pmTypeMappingInputSchema.safeParse({
    ...input,
    carc: input.carc.trim().toUpperCase(),
  });
  if (!parsed.success)
    return {
      ok: false,
      message: 'Enter the 835 code (group and number) and the PM code (letters and numbers).',
    };
  const res = await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, (tx) =>
    savePmTypeMapping(tx, { tenantId: ctx.tenantId, userId: ctx.user.id }, parsed.data),
  );
  const pair = `${parsed.data.groupCode}-${parsed.data.carc}`;
  if (!res.ok)
    return {
      ok: false,
      message:
        res.reason === 'denial_code'
          ? `${pair} is a denial: the balance stays open for the denial queue, so it is never mapped.`
          : 'No client uses this PM.',
    };
  log.info({ itemsClosed: res.itemsClosed, clientsChecked: res.clientsChecked }, 'mapping saved (S-08)');
  revalidatePath('/settings/mappings');
  revalidatePath('/work');
  return {
    ok: true,
    message: res.itemsClosed
      ? `Saved ${pair}. ${res.itemsClosed === 1 ? 'One client' : `${res.itemsClosed} clients`} waiting on it checked again.`
      : `Saved ${pair}. It applies to payments posted from now on.`,
  };
}
