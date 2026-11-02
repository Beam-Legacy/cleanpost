/** Claim versions: every change is a new version, never an edit in place (CLAUDE.md rule 4). */
import { and, desc, eq, notLike } from 'drizzle-orm';
import { claimLines, claimVersions, type AuditActor, type Tx } from '@cleanpost/db';
import type { ClaimPayload } from '@cleanpost/domain';

export async function insertVersion(
  tx: Tx,
  claim: { id: string; tenantId: string; clientId: string },
  version: number,
  payload: ClaimPayload,
  actor: AuditActor,
) {
  const [v] = await tx
    .insert(claimVersions)
    .values({
      tenantId: claim.tenantId,
      clientId: claim.clientId,
      claimId: claim.id,
      version,
      frequencyCode: payload.frequencyCode,
      payload,
      createdBy: actor,
    })
    .returning({ id: claimVersions.id });
  await tx.insert(claimLines).values(
    payload.lines.map((l) => ({
      tenantId: claim.tenantId,
      clientId: claim.clientId,
      claimVersionId: v!.id,
      lineNumber: l.lineNumber,
      chargeLineId: l.chargeLineId,
      code: l.code,
      modifiers: l.modifiers,
      units: l.units,
      chargeCents: l.chargeCents,
      dxPointers: l.dxPointers,
    })),
  );
  return v!.id;
}

/** The last version built from the PM (not by a person): what the PM holds now, as far as we know. */
export async function lastPmVersion(tx: Tx, claimId: string) {
  const [v] = await tx
    .select()
    .from(claimVersions)
    .where(and(eq(claimVersions.claimId, claimId), notLike(claimVersions.createdBy, 'user:%')))
    .orderBy(desc(claimVersions.version))
    .limit(1);
  return v ?? null;
}
