/**
 * CL-08 Pause and resume a client (docs/03 Client). Paused: syncing, eligibility and scrubbing keep
 * running; releases and PM write-backs wait (release.ts, edit.ts). Resume hands back the claims that
 * waited, so the caller can queue their release and their PM corrections. Audited.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { claims, clients, recordAudit, withTenant, type Database } from '@cleanpost/db';
import { state } from '@cleanpost/domain';
import { correctionPending } from './tasks';

type Ctx = { tenantId: string; userId: string };

export interface PauseInput {
  reason: (typeof state.PAUSE_REASONS)[number];
  note: string | null;
  /** YYYY-MM-DD, a reminder shown on the banner; resuming is a person's decision. */
  resumeOn: string | null;
}

export type ClientStatusResult<T = object> =
  ({ ok: true } & T) | { ok: false; reason: 'not_found' | 'invalid_state' | 'note_required' };

export async function pauseClient(
  db: Database,
  ctx: Ctx,
  clientId: string,
  input: PauseInput,
  now: Date,
): Promise<ClientStatusResult> {
  if (input.reason === 'Other' && !input.note?.trim()) return { ok: false, reason: 'note_required' };
  return withTenant(db, ctx, async (tx) => {
    const [c] = await tx.select().from(clients).where(eq(clients.id, clientId)).for('update');
    if (!c) return { ok: false, reason: 'not_found' };
    const next = state.nextClientState(c.status as state.ClientState, 'pause');
    if (!next.ok) return { ok: false, reason: 'invalid_state' };
    await tx
      .update(clients)
      .set({
        status: next.value,
        pause: {
          reason: input.reason,
          note: input.note?.trim() || null,
          resumeOn: input.resumeOn,
          pausedAt: now.toISOString(),
          pausedBy: `user:${ctx.userId}`,
        },
        updatedAt: now,
      })
      .where(eq(clients.id, c.id));
    await recordAudit(tx, {
      actor: `user:${ctx.userId}`,
      action: 'client.paused',
      entityType: 'client',
      entityId: c.id,
      clientId: c.id,
      metadata: { reason: input.reason, resumeOn: input.resumeOn },
    });
    return { ok: true };
  });
}

/** Resume: live again; returns the claims waiting to be released and to be corrected in the PM. */
export async function resumeClient(
  db: Database,
  ctx: Ctx,
  clientId: string,
  now: Date,
): Promise<ClientStatusResult<{ toRelease: string[]; toCorrect: { claimId: string; versionId: string }[] }>> {
  return withTenant(db, ctx, async (tx) => {
    const [c] = await tx.select().from(clients).where(eq(clients.id, clientId)).for('update');
    if (!c) return { ok: false, reason: 'not_found' };
    const next = state.nextClientState(c.status as state.ClientState, 'resume');
    if (!next.ok) return { ok: false, reason: 'invalid_state' };
    await tx
      .update(clients)
      .set({ status: next.value, pause: null, updatedAt: now })
      .where(eq(clients.id, c.id));
    await recordAudit(tx, {
      actor: `user:${ctx.userId}`,
      action: 'client.resumed',
      entityType: 'client',
      entityId: c.id,
      clientId: c.id,
    });
    const ready = await tx
      .select({ id: claims.id })
      .from(claims)
      .where(and(eq(claims.clientId, c.id), eq(claims.status, 'ready')));
    const open = await tx
      .select({ id: claims.id, versionId: claims.currentVersionId })
      .from(claims)
      .where(
        and(
          eq(claims.clientId, c.id),
          eq(claims.mode, 'A'),
          // Corrections matter before the claim goes out.
          inArray(claims.status, ['needs_review', 'blocked', 'ready', 'corrected']),
        ),
      );
    const toCorrect: { claimId: string; versionId: string }[] = [];
    for (const o of open)
      if (o.versionId && (await correctionPending(tx, o.id)))
        toCorrect.push({ claimId: o.id, versionId: o.versionId });
    const correcting = new Set(toCorrect.map((c) => c.claimId));
    return { ok: true, toRelease: ready.map((r) => r.id).filter((id) => !correcting.has(id)), toCorrect };
  });
}
