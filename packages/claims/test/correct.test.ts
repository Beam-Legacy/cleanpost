/**
 * Flow 5, denial to corrected claim (docs/09), and write-off (C-14): on Willamette (Tebra), a claim
 * goes out, the payer denies it, a person builds the correction with the suggested fix, it is
 * scrubbed, approved and released as a task to resubmit it from Tebra (frequency 7), and the denial
 * closes itself when the PM shows the corrected claim accepted.
 */
import { and, eq, inArray, ne } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claimEvents,
  claims,
  claimVersions,
  externalRefs,
  manualTasks,
  notifications,
  remitClaims,
  remittances,
  tenants,
  withTenant,
  workItems,
  writeOffRequests,
} from '@cleanpost/db';
import type { ClaimPayload } from '@cleanpost/domain';
import { pmSchema } from '@cleanpost/pm-mock';
import { seedReference } from '@cleanpost/seed/reference';
import { runSync } from '@cleanpost/sync';
import {
  applyClaimEvent,
  applyClaimStatuses,
  approveClaim,
  buildClaimsForClient,
  buildCorrection,
  decideWriteOff,
  releaseClaim,
  requestWriteOff,
  scrubVersion,
  writeOffClaim,
  writeOffDenials,
} from '../src';
import {
  admin,
  app,
  client,
  closeAll,
  connectionOf,
  log,
  NORTHWIND,
  pm,
  registry,
  syncedWorld,
  userIdOf,
} from './helpers';

const willamette = () => client('Willamette');
const deps = { db: app.db, registry, log };
let user = '';
let biller = '';

async function sync() {
  const conn = await connectionOf('Willamette');
  await runSync(
    { db: app.db, registry, log, retryDelaysMs: [10], appliers: { pullClaimsAndStatus: applyClaimStatuses } },
    { tenantId: NORTHWIND, connectionId: conn.id, trigger: 'manual' },
  );
}

async function pmClaimOf(claimId: string) {
  const [c] = await admin.db.select().from(claims).where(eq(claims.id, claimId));
  const [ref] = await admin.db
    .select()
    .from(externalRefs)
    .where(and(eq(externalRefs.entityId, c!.encounterId), eq(externalRefs.entityType, 'encounter')));
  return ref!.externalId;
}

const claimRow = async (id: string) => (await admin.db.select().from(claims).where(eq(claims.id, id)))[0]!;

/**
 * One Willamette claim in review: scrubbed here on its own, so the other files' claims (and the
 * client rule release.test adds before its own scrub) are left as they are.
 */
async function oneInReview() {
  const ready = await admin.db
    .select()
    .from(claims)
    .where(and(eq(claims.clientId, willamette().id), eq(claims.status, 'needs_review')))
    .limit(1);
  if (ready[0]) return ready[0];
  const built = await admin.db
    .select()
    .from(claims)
    .where(and(eq(claims.clientId, willamette().id), eq(claims.status, 'built')))
    .limit(20);
  for (const b of built) {
    await scrubVersion({ db: app.db, log }, { tenantId: NORTHWIND, claimVersionId: b.currentVersionId! });
    const after = await claimRow(b.id);
    if (after.status === 'needs_review') return after;
  }
  throw new Error('no Willamette claim in review');
}

/** A Willamette claim out the door and accepted by the payer, as the PM reports it. */
async function acceptedClaim() {
  const c = await oneInReview();
  expect((await approveClaim(app.db, { tenantId: NORTHWIND, userId: user, claimId: c.id })).ok).toBe(true);
  expect(await releaseClaim(deps, { tenantId: NORTHWIND, claimId: c.id }, `user:${user}`)).toMatchObject({
    status: 'released',
  });
  const eid = await pmClaimOf(c.id);
  await pm.db
    .update(pmSchema.claims)
    .set({ status: 'accepted', updatedAt: new Date() })
    .where(eq(pmSchema.claims.encounterId, eid));
  await sync();
  expect((await claimRow(c.id)).status).toBe('accepted');
  return { claimId: c.id, encounterId: eid };
}

/** The payer's denial as ingestion leaves it: the 835 claim with its number, the claim denied, one item. */
async function deny(claimId: string, payerClaimNumber: string) {
  const c = await claimRow(claimId);
  return withTenant(app.db, { tenantId: NORTHWIND }, async (tx) => {
    const [r] = await tx
      .insert(remittances)
      .values({
        tenantId: NORTHWIND,
        clientId: c.clientId,
        payerName: 'CIGNA',
        source: 'file',
        traceNumber: `TRC-${payerClaimNumber}`,
        paymentMethod: 'NON',
        paymentAmountCents: 0,
        paymentDate: '2026-11-10',
        status: 'reconciled',
      })
      .returning();
    await tx.insert(remitClaims).values({
      tenantId: NORTHWIND,
      clientId: c.clientId,
      remittanceId: r!.id,
      claimId,
      patientControlNumber: c.patientControlNumber,
      payerClaimControlNumber: payerClaimNumber,
      claimStatusCode: '4',
      chargeCents: c.totalChargeCents,
      paidCents: 0,
      matchStatus: 'matched',
      matchedBy: 'pcn',
    });
    await applyClaimEvent(tx, c, 'deny', { actor: 'automation:test', versionId: c.currentVersionId });
    const [item] = await tx
      .insert(workItems)
      .values({
        tenantId: NORTHWIND,
        clientId: c.clientId,
        type: 'denial',
        priority: 2,
        dueAt: new Date(Date.now() + 48 * 3_600_000),
        claimId,
        remittanceId: r!.id,
        reasonCode: '4',
        summary: 'Denied: CO-4',
        amountCents: c.totalChargeCents,
      })
      .returning();
    return item!.id;
  });
}

/**
 * For write-off tests, which need no PM round trip: a Willamette claim out the door and denied.
 * Takes a claim the payer already has (accepted or submitted, left by the other tests), else one the
 * scrub passed and the PM bills, never the claims in review that release.test needs; files run in
 * any order, so the pool is whatever the other files have left.
 */
async function deniedClaim(payerClaimNumber: string) {
  const pick = async () => {
    const rows = await admin.db
      .select()
      .from(claims)
      .where(
        and(eq(claims.clientId, willamette().id), inArray(claims.status, ['accepted', 'submitted', 'ready'])),
      );
    return ['accepted', 'submitted', 'ready'].flatMap((st) => rows.filter((r) => r.status === st))[0];
  };
  let c = await pick();
  if (!c) {
    const built = await admin.db
      .select()
      .from(claims)
      .where(and(eq(claims.clientId, willamette().id), eq(claims.status, 'built')))
      .limit(20);
    for (const b of built) {
      await scrubVersion({ db: app.db, log }, { tenantId: NORTHWIND, claimVersionId: b.currentVersionId! });
      if ((c = await pick())) break;
    }
  }
  if (!c) throw new Error('no Willamette claim to deny');
  const claim = c;
  await withTenant(app.db, { tenantId: NORTHWIND }, async (tx) => {
    if (claim.status === 'ready')
      await applyClaimEvent(tx, claim, 'billed_outside', { actor: 'automation:test' });
    if (claim.status !== 'accepted')
      await applyClaimEvent(tx, { ...claim, status: 'submitted' }, 'accept', { actor: 'automation:test' });
  });
  return { claimId: claim.id, denialItemId: await deny(claim.id, payerClaimNumber) };
}

const openDenials = (claimId: string) =>
  admin.db
    .select()
    .from(workItems)
    .where(
      and(eq(workItems.claimId, claimId), eq(workItems.type, 'denial'), ne(workItems.status, 'resolved')),
    );

beforeAll(async () => {
  await syncedWorld();
  await seedReference(admin.db);
  user = await userIdOf('julia@northwind.test');
  biller = await userIdOf('marcus@northwind.test');
  await buildClaimsForClient(app.db, { tenantId: NORTHWIND, clientId: willamette().id });
}, 240_000);

afterAll(async () => {
  await closeAll();
});

describe('Flow 5: denial to corrected claim (Mode A, Tebra)', () => {
  it('builds the correction, resubmits it from the PM, and the denial closes when it is accepted', async () => {
    const { claimId, encounterId } = await acceptedClaim();
    // The old claim's denial is on the PM's record from before the correction.
    await pm.db
      .update(pmSchema.claims)
      .set({ status: 'denied', updatedAt: new Date() })
      .where(eq(pmSchema.claims.encounterId, encounterId));
    await deny(claimId, 'CIG-2026-0001');
    expect(await openDenials(claimId)).toHaveLength(1);

    const before = await claimRow(claimId);
    const [v1] = await admin.db
      .select()
      .from(claimVersions)
      .where(eq(claimVersions.id, before.currentVersionId!));
    const line = (v1!.payload as ClaimPayload).lines[0]!;
    const modifier = ['25', '59', 'XS'].find((m) => !line.modifiers.includes(m))!;
    const built = await buildCorrection(
      app.db,
      { tenantId: NORTHWIND, userId: user, claimId },
      {
        fix: {
          fix: { op: 'addModifier', lineMatch: { codeIn: [line.code] }, modifier },
          lineNumbers: [line.lineNumber],
        },
      },
    );
    expect(built).toMatchObject({ status: 'built', originalRef: 'CIG-2026-0001', fixed: true });
    const versions = await admin.db.select().from(claimVersions).where(eq(claimVersions.claimId, claimId));
    const latest = versions.sort((a, b) => b.version - a.version)[0]!;
    expect(latest).toMatchObject({ frequencyCode: '7', originalRef: 'CIG-2026-0001' });
    expect((latest.payload as ClaimPayload).lines[0]!.modifiers).toContain(modifier);
    expect((await claimRow(claimId)).status).toBe('built');
    // A second correction while this one is on its way is refused.
    expect(await buildCorrection(app.db, { tenantId: NORTHWIND, userId: user, claimId }, {})).toEqual({
      status: 'refused',
      reason: 'in_flight',
    });

    // Scrubbed like any version, approved, and released: a task to resubmit it from Tebra.
    await scrubVersion({ db: app.db, log }, { tenantId: NORTHWIND, claimVersionId: latest.id });
    if ((await claimRow(claimId)).status === 'needs_review')
      expect((await approveClaim(app.db, { tenantId: NORTHWIND, userId: user, claimId })).ok).toBe(true);
    const released = await releaseClaim(deps, { tenantId: NORTHWIND, claimId }, `user:${user}`);
    expect(released).toMatchObject({ status: 'manual_task' });
    const [task] = await admin.db
      .select()
      .from(manualTasks)
      .innerJoin(workItems, eq(workItems.id, manualTasks.workItemId))
      .where(and(eq(workItems.claimId, claimId), eq(manualTasks.operation, 'resubmitCorrected')));
    expect(task!.manual_tasks.instructions.join('\n')).toMatch(new RegExp(`modifier ${modifier} added`, 'i'));
    expect(task!.manual_tasks.instructions.join('\n')).toContain('original claim number CIG-2026-0001');

    // The old denial on the PM's record does not count as sent.
    await sync();
    expect((await claimRow(claimId)).status).toBe('ready');

    // The biller resubmits it in Tebra; the payer accepts it.
    await pm.db
      .update(pmSchema.claims)
      .set({ status: 'sent', frequencyCode: '7', originalRef: 'CIG-2026-0001', updatedAt: new Date() })
      .where(eq(pmSchema.claims.encounterId, encounterId));
    await sync();
    expect((await claimRow(claimId)).status).toBe('submitted');
    expect(await openDenials(claimId)).toHaveLength(1);
    await pm.db
      .update(pmSchema.claims)
      .set({ status: 'accepted', updatedAt: new Date() })
      .where(eq(pmSchema.claims.encounterId, encounterId));
    await sync();
    expect((await claimRow(claimId)).status).toBe('accepted');
    expect(await openDenials(claimId)).toHaveLength(0);
    const [closed] = await admin.db
      .select()
      .from(workItems)
      .where(and(eq(workItems.claimId, claimId), eq(workItems.type, 'denial')));
    expect(closed!.resolution).toBe('Corrected claim accepted');
    const events = await admin.db
      .select({ type: claimEvents.type })
      .from(claimEvents)
      .where(eq(claimEvents.claimId, claimId));
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['denied', 'corrected', 'released', 'ack_277ca']),
    );
  });

  it('refuses a correction without the payer claim number, or for a claim that was not denied', async () => {
    const { claimId } = await acceptedClaim();
    expect(await buildCorrection(app.db, { tenantId: NORTHWIND, userId: user, claimId }, {})).toEqual({
      status: 'refused',
      reason: 'not_denied',
    });
    await withTenant(app.db, { tenantId: NORTHWIND }, async (tx) => {
      const c = await claimRow(claimId);
      await applyClaimEvent(tx, c, 'deny', { actor: 'automation:test' });
    });
    expect(await buildCorrection(app.db, { tenantId: NORTHWIND, userId: user, claimId }, {})).toEqual({
      status: 'refused',
      reason: 'no_payer_claim_number',
    });
  });
});

describe('write-off (C-14, D-03)', () => {
  it('closes the balance with a reason, closes the denial, and leaves a task to post it in Tebra', async () => {
    const { claimId } = await deniedClaim('CIG-2026-0002');
    const c = await claimRow(claimId);
    const call = (amountCents: number, note: string | null = null) =>
      writeOffClaim(
        app.db,
        { tenantId: NORTHWIND, userId: user, claimId, overLimit: 'allowed' },
        { amountCents, reason: 'Not worth pursuing', note, pmCode: 'wo' },
      );
    expect(await call(c.balanceCents + 1)).toEqual({ status: 'refused', reason: 'amount' });
    const res = await call(c.balanceCents, 'Under the client threshold');
    expect(res).toMatchObject({ status: 'written_off', amountCents: c.balanceCents });
    const after = await claimRow(claimId);
    expect(after).toMatchObject({ status: 'closed', balanceCents: 0 });
    expect(await openDenials(claimId)).toHaveLength(0);
    const [task] = await admin.db
      .select()
      .from(manualTasks)
      .where(eq(manualTasks.workItemId, (res as { workItemId: string }).workItemId));
    expect(task!.instructions.join('\n')).toContain('with code WO');
  });

  /** The tenant's approval limit, lowered for a test so any synthetic claim is over it. */
  async function withLimit<T>(cents: number, run: () => Promise<T>): Promise<T> {
    const [t] = await admin.db.select().from(tenants).where(eq(tenants.id, NORTHWIND));
    const settings = (t!.settings ?? {}) as Record<string, unknown>;
    await admin.db
      .update(tenants)
      .set({ settings: { ...settings, writeOffApprovalLimitCents: cents } })
      .where(eq(tenants.id, NORTHWIND));
    try {
      return await run();
    } finally {
      await admin.db.update(tenants).set({ settings }).where(eq(tenants.id, NORTHWIND));
    }
  }

  const requestOf = async (id: string) =>
    (await admin.db.select().from(writeOffRequests).where(eq(writeOffRequests.id, id)))[0]!;
  const itemOf = async (id: string) =>
    (await admin.db.select().from(workItems).where(eq(workItems.id, id)))[0]!;

  it('over the approval limit, a biller asks; an admin approves and the write-off is done as the admin', async () => {
    await withLimit(1_000, async () => {
      const { claimId, denialItemId } = await deniedClaim('CIG-2026-0003');
      const c = await claimRow(claimId);
      const input = {
        amountCents: c.balanceCents,
        reason: 'Practice instruction' as const,
        note: 'The practice asked to write it off',
        pmCode: 'adm',
        denialItemId,
      };
      expect(await writeOffClaim(app.db, { tenantId: NORTHWIND, userId: biller, claimId }, input)).toEqual({
        status: 'refused',
        reason: 'over_limit',
      });

      const req = await requestWriteOff(app.db, { tenantId: NORTHWIND, userId: biller, claimId }, input);
      expect(req.status).toBe('requested');
      const { requestId, approvalItemId } = req as { requestId: string; approvalItemId: string };
      expect(await itemOf(approvalItemId)).toMatchObject({
        type: 'write_off_approval',
        status: 'open',
        amountCents: c.balanceCents,
      });
      expect(await requestWriteOff(app.db, { tenantId: NORTHWIND, userId: biller, claimId }, input)).toEqual({
        status: 'refused',
        reason: 'already_requested',
      });
      // Nothing is written off while it waits.
      expect((await claimRow(claimId)).status).toBe('denied');

      const decided = await decideWriteOff(
        app.db,
        { tenantId: NORTHWIND, userId: user, requestId },
        'approve',
        null,
      );
      expect(decided.status).toBe('approved');
      expect(await claimRow(claimId)).toMatchObject({ status: 'closed', balanceCents: 0 });
      expect(await requestOf(requestId)).toMatchObject({ status: 'approved', decidedBy: `user:${user}` });
      expect(await itemOf(approvalItemId)).toMatchObject({ status: 'resolved', resolution: 'Approved' });
      expect(await itemOf(denialItemId)).toMatchObject({ status: 'resolved', resolution: 'Written off' });
      const [ev] = await admin.db
        .select()
        .from(claimEvents)
        .where(and(eq(claimEvents.claimId, claimId), eq(claimEvents.type, 'closed')));
      expect(ev).toMatchObject({ actor: `user:${user}` });
      expect(ev!.payload).toMatchObject({ requestedBy: `user:${biller}`, requestId });
      const notes = await admin.db
        .select()
        .from(notifications)
        .where(and(eq(notifications.userId, biller), eq(notifications.entityId, claimId)));
      expect(notes.map((n) => n.type)).toEqual(['write_off_approved']);
      // Decided once.
      expect(
        await decideWriteOff(app.db, { tenantId: NORTHWIND, userId: user, requestId }, 'decline', null),
      ).toEqual({ status: 'refused', reason: 'not_pending' });
    });
  });

  it('a declined request leaves the denial open; a direct write-off cancels a request it makes moot', async () => {
    await withLimit(1_000, async () => {
      const { claimId, denialItemId } = await deniedClaim('CIG-2026-0004');
      const c = await claimRow(claimId);
      const input = {
        amountCents: c.balanceCents,
        reason: 'Not worth pursuing' as const,
        note: 'Small balance',
        pmCode: 'wo',
        denialItemId,
      };
      const first = (await requestWriteOff(
        app.db,
        { tenantId: NORTHWIND, userId: biller, claimId },
        input,
      )) as {
        requestId: string;
        approvalItemId: string;
      };
      expect(
        await decideWriteOff(
          app.db,
          { tenantId: NORTHWIND, userId: user, requestId: first.requestId },
          'decline',
          'Correct it instead',
        ),
      ).toEqual({ status: 'declined' });
      expect(await requestOf(first.requestId)).toMatchObject({
        status: 'declined',
        decisionNote: 'Correct it instead',
      });
      expect(await itemOf(first.approvalItemId)).toMatchObject({
        status: 'resolved',
        resolution: 'Declined',
      });
      expect(await itemOf(denialItemId)).toMatchObject({ status: 'open' });
      expect((await claimRow(claimId)).status).toBe('denied');

      // Asked again, then an admin writes it off directly: the waiting request is no longer needed.
      const second = (await requestWriteOff(
        app.db,
        { tenantId: NORTHWIND, userId: biller, claimId },
        input,
      )) as {
        requestId: string;
        approvalItemId: string;
      };
      expect(
        await writeOffClaim(
          app.db,
          { tenantId: NORTHWIND, userId: user, claimId, overLimit: 'allowed' },
          input,
        ),
      ).toMatchObject({ status: 'written_off' });
      expect(await requestOf(second.requestId)).toMatchObject({ status: 'cancelled' });
      expect(await itemOf(second.approvalItemId)).toMatchObject({
        status: 'resolved',
        resolution: 'No longer needed',
      });
    });
  });

  it('writes off the denied amount only: what the patient owes on other lines stays open', async () => {
    const { claimId, denialItemId } = await deniedClaim('CIG-2026-0005');
    const c = await claimRow(claimId);
    const patientOwes = 2_000;
    await admin.db
      .update(workItems)
      .set({ amountCents: c.balanceCents - patientOwes })
      .where(eq(workItems.id, denialItemId));
    const res = await writeOffClaim(
      app.db,
      { tenantId: NORTHWIND, userId: user, claimId, overLimit: 'allowed' },
      {
        amountCents: c.balanceCents - patientOwes,
        reason: 'Not worth pursuing',
        note: 'Denied office visit',
        pmCode: 'wo',
        denialItemId,
      },
    );
    expect(res).toMatchObject({ status: 'written_off' });
    expect(await claimRow(claimId)).toMatchObject({ status: 'denied', balanceCents: patientOwes });
    expect(await itemOf(denialItemId)).toMatchObject({ status: 'resolved', resolution: 'Written off' });
  });

  it('bulk (admin) writes off each denial with one reason and code, and reports what it could not', async () => {
    const a = await deniedClaim('CIG-2026-0006');
    const b = await deniedClaim('CIG-2026-0007');
    const [ia, ib] = [a.denialItemId, b.denialItemId];
    const total = (await claimRow(a.claimId)).balanceCents + (await claimRow(b.claimId)).balanceCents;
    const res = await writeOffDenials(app.db, { tenantId: NORTHWIND, userId: user }, [ia, ib, ia], {
      reason: 'Timely filing missed',
      note: 'Past the filing limit',
      pmCode: 'tfwo',
    });
    expect(res).toEqual({ writtenOff: 2, cents: total, refused: [{ itemId: ia, reason: 'not_open' }] });
    expect((await claimRow(a.claimId)).status).toBe('closed');
    expect((await claimRow(b.claimId)).status).toBe('closed');
  });
});
