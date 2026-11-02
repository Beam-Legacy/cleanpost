/**
 * The PM's postings as `pullPostings` reads them (Modes A, C), stored for the posting match. Each
 * posting line gets a key from its own fields, so overlapping sync windows do not store it twice.
 */
import { createHash } from 'node:crypto';
import type { ExtPosting } from '@cleanpost/adapters';
import { pmPostings, type Tx } from '@cleanpost/db';

export function postingKey(p: ExtPosting): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        p.remittanceExternalId ?? null,
        p.traceNumber,
        p.encounterExternalId,
        p.lineExternalId ?? null,
        p.paidCents,
        p.adjustments,
        p.patientRespCents,
        p.postedAt,
      ]),
    )
    .digest('hex');
}

export async function storePmPostings(
  tx: Tx,
  ctx: { tenantId: string; clientId: string; connectionId: string },
  items: ExtPosting[],
): Promise<{ created: number; unchanged: number }> {
  let created = 0;
  for (const p of items) {
    const rows = await tx
      .insert(pmPostings)
      .values({
        tenantId: ctx.tenantId,
        clientId: ctx.clientId,
        connectionId: ctx.connectionId,
        externalKey: postingKey(p),
        traceNumber: p.traceNumber,
        encounterExternalId: p.encounterExternalId,
        lineExternalId: p.lineExternalId ?? null,
        paidCents: p.paidCents,
        adjustments: p.adjustments,
        patientRespCents: p.patientRespCents,
        postedAt: new Date(p.postedAt),
      })
      .onConflictDoNothing()
      .returning({ id: pmPostings.id });
    created += rows.length;
  }
  return { created, unchanged: items.length - created };
}
