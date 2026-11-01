'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { recordAudit, withTenant } from '@cleanpost/db';
import { policy } from '@cleanpost/domain';
import { sendSyncPull } from '@cleanpost/jobs';
import { setPaused } from '@cleanpost/sync';
import { getBoss } from '@/lib/jobs';
import { getConnection } from '@/lib/queries/integrations';
import { getDb } from '@/lib/server';
import { requireActiveContext } from '@/lib/session';

export interface SyncControlResult {
  ok: boolean;
  message: string;
}

const Id = z.uuid();

async function adminContext() {
  const ctx = await requireActiveContext();
  policy.assertAllowed(ctx.actor, 'integration.manage');
  return ctx;
}

/** I-02 Run now: queues one sync.pull for the connection (IDs only), at most one at a time. */
export async function runNow(connectionId: string): Promise<SyncControlResult> {
  const ctx = await adminContext();
  const id = Id.parse(connectionId);
  const conn = await getConnection(ctx, id);
  if (!conn) return { ok: false, message: 'Connection not found.' };
  if (conn.status === 'paused') return { ok: false, message: 'Resume syncing first.' };
  if (conn.status === 'setup') return { ok: false, message: 'Finish setting up this connection first.' };
  const jobId = await sendSyncPull(await getBoss(), {
    tenantId: ctx.tenantId,
    connectionId: id,
    trigger: 'manual',
    userId: ctx.user.id,
  });
  await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, (tx) =>
    recordAudit(tx, {
      actor: `user:${ctx.user.id}`,
      action: 'connection.sync_requested',
      entityType: 'connection',
      entityId: id,
      clientId: conn.clientId,
      metadata: { queued: Boolean(jobId) },
    }),
  );
  revalidatePath(`/integrations/${id}`);
  return jobId
    ? { ok: true, message: 'Sync queued. Results appear under Recent runs.' }
    : { ok: true, message: 'A sync for this connection is already queued or running.' };
}

/** I-02 Pause syncing / Resume syncing, through the connection state machine. */
export async function setSyncPaused(connectionId: string, paused: boolean): Promise<SyncControlResult> {
  const ctx = await adminContext();
  const id = Id.parse(connectionId);
  const res = await setPaused(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, id, paused);
  revalidatePath(`/integrations/${id}`);
  revalidatePath('/integrations');
  if (!res.ok)
    return {
      ok: false,
      message: paused ? 'This connection cannot be paused now.' : 'This connection is not paused.',
    };
  return {
    ok: true,
    message: paused ? 'Syncing paused. Nothing is read from the PM until you resume.' : 'Syncing resumed.',
  };
}
