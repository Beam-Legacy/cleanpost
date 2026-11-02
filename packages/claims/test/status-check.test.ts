/**
 * Claim status checks (C-15, W-15) on Willamette against payer-sim's 277 (Stedi's JSON shape):
 * the daily sweep opens a follow-up for a claim with no acknowledgment, the check finds the payer
 * has it and accepts it, and the follow-up closes; a person checks at most once a day; a claim the
 * payer has no record of gets a task to resubmit it; follow-ups close when the claim moves on.
 */
import { and, eq, inArray, ne } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claimEvents,
  claims,
  claimVersions,
  clients,
  coverages,
  decryptField,
  encounters,
  manualTasks,
  payers,
  withTenant,
  workItems,
} from '@cleanpost/db';
import { testDatabaseUrls } from '@cleanpost/db/testing';
import { claimStatus, type ClaimPayload } from '@cleanpost/domain';
import { createStediClaimStatusClient } from '@cleanpost/eligibility';
import { createPayerSimApp, createSimDb, simSchema } from '@cleanpost/payer-sim';
import { seedReference } from '@cleanpost/seed/reference';
import {
  applyClaimEvent,
  buildClaimsForClient,
  checkClaimStatus,
  createStatusTask,
  statusSweep,
} from '../src';
import { admin, app, client, closeAll, log, NORTHWIND, syncedWorld, userIdOf } from './helpers';

const willamette = () => client('Willamette');
const simDb = createSimDb(testDatabaseUrls().adminUrl, 2);
const sim = createPayerSimApp({ db: simDb.db, log });
const statusClient = createStediClaimStatusClient({
  apiKey: 'payer-sim',
  baseUrl: 'http://payer-sim.test',
  kind: 'payer-sim',
  fetch: ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(sim.request(String(input).replace('http://payer-sim.test', ''), init))) as typeof fetch,
});
const DAY = 86_400_000;
let user = '';

const claimRow = async (id: string) => (await admin.db.select().from(claims).where(eq(claims.id, id)))[0]!;
const deps = (now: Date) => ({ db: app.db, client: statusClient, log, now: () => now });

/**
 * A Willamette claim the PM sent that no 277CA has answered: one release.test left submitted, else
 * one not yet released, billed outside Cleanpost. The pool is large enough for every file.
 */
async function sentClaim(pcn: string) {
  const rows = await admin.db
    .select()
    .from(claims)
    .where(
      and(
        eq(claims.clientId, willamette().id),
        inArray(claims.status, ['submitted', 'blocked', 'needs_review', 'built']),
      ),
    );
  // Not one an earlier sweep here already gave a follow-up (sweeps cover the whole tenant).
  const followed = new Set(
    (
      await admin.db
        .select({ id: workItems.claimId })
        .from(workItems)
        .where(eq(workItems.type, 'no_response'))
    ).map((w) => w.id),
  );
  const c = ['submitted', 'blocked', 'needs_review', 'built'].flatMap((st) =>
    rows.filter((r) => r.status === st && !followed.has(r.id)),
  )[0];
  if (!c) throw new Error('no Willamette claim to send');
  await withTenant(app.db, { tenantId: NORTHWIND }, async (tx) => {
    await tx.update(claims).set({ patientControlNumber: pcn }).where(eq(claims.id, c.id));
    if (c.status !== 'submitted')
      await applyClaimEvent(tx, c, 'billed_outside', { actor: 'automation:test', payload: { via: 'test' } });
  });
  return claimRow(c.id);
}

/** What the payer received for the claim: payer-sim's submission row, acknowledged already. */
async function payerHas(c: typeof claims.$inferSelect) {
  const [row] = await admin.db
    .select({
      payload: claimVersions.payload,
      memberId: coverages.memberIdEncrypted,
      payerId: payers.stediPayerId,
      npi: clients.billingNpi,
      dos: encounters.dateOfService,
    })
    .from(claims)
    .innerJoin(claimVersions, eq(claimVersions.id, claims.currentVersionId))
    .innerJoin(coverages, eq(coverages.id, claims.coverageId))
    .innerJoin(payers, eq(payers.id, claims.payerId))
    .innerJoin(clients, eq(clients.id, claims.clientId))
    .innerJoin(encounters, eq(encounters.id, claims.encounterId))
    .where(eq(claims.id, c.id));
  const p = row!.payload as ClaimPayload;
  await simDb.db.insert(simSchema.submissions).values({
    id: `test:${c.patientControlNumber}`,
    source: 'test',
    patientControlNumber: c.patientControlNumber!,
    payerName: 'Payer',
    payerId: row!.payerId,
    memberId: decryptField(row!.memberId),
    dateOfService: row!.dos,
    claim: {
      patientControlNumber: c.patientControlNumber!,
      payerName: 'Payer',
      dateOfService: row!.dos,
      renderingNpi: row!.npi,
      billingNpi: row!.npi,
      member: { status: 'active' },
      diagnoses: p.diagnoses,
      lines: p.lines.map((l) => ({ ...l, pointers: l.dxPointers })),
      totalChargeCents: p.totalChargeCents,
    },
    receivedAt: new Date(Date.now() - 2 * DAY),
    ackDueAt: new Date(Date.now() - DAY),
    ackStatus: 'accepted',
    ackCodes: ['A2:20'],
    ackReasons: [],
  });
}

const followUps = (claimId: string) =>
  admin.db
    .select()
    .from(workItems)
    .where(and(eq(workItems.claimId, claimId), eq(workItems.type, 'no_response')));

beforeAll(async () => {
  await syncedWorld();
  await seedReference(admin.db);
  user = await userIdOf('julia@northwind.test');
  await buildClaimsForClient(app.db, { tenantId: NORTHWIND, clientId: willamette().id });
}, 240_000);

afterAll(async () => {
  await Promise.all([closeAll(), simDb.close()]);
});

describe('claim status checks (276/277)', () => {
  it('opens a follow-up for no acknowledgment; the check finds the payer has it and closes it', async () => {
    const c = await sentClaim('STS-0001');
    await payerHas(c);
    const later = new Date(Date.now() + 8 * DAY);
    const sweep = await statusSweep(app.db, { tenantId: NORTHWIND }, later);
    expect(sweep.due).toContain(c.id);
    const [item] = await followUps(c.id);
    expect(item).toMatchObject({ status: 'open', reasonCode: 'no_ack', priority: 3 });
    expect(item!.summary).toMatch(/^No acknowledgment from .+ 8 days after it was sent\.$/);
    // A second sweep opens no second follow-up.
    await statusSweep(app.db, { tenantId: NORTHWIND }, later);
    expect(await followUps(c.id)).toHaveLength(1);

    const res = await checkClaimStatus(deps(later), { tenantId: NORTHWIND, claimId: c.id, trigger: 'sweep' });
    expect(res).toMatchObject({ status: 'checked', accepted: true });
    const kind = (res as { kind: claimStatus.StatusKind }).kind;
    expect(['pending', 'needs_info']).toContain(kind);
    expect((await claimRow(c.id)).status).toBe('accepted');
    expect((await followUps(c.id))[0]).toMatchObject({ status: 'resolved', resolution: 'Payer accepted it' });
    const [event] = await admin.db
      .select()
      .from(claimEvents)
      .where(and(eq(claimEvents.claimId, c.id), eq(claimEvents.type, 'status_277')));
    expect(event!.payload).toMatchObject({
      trigger: 'sweep',
      source: 'payer-sim',
      category: kind === 'pending' ? 'P1' : 'P3',
      submittedCents: c.totalChargeCents,
    });
    // The next weekly check is not due yet.
    expect((await statusSweep(app.db, { tenantId: NORTHWIND }, later)).due).not.toContain(c.id);
  });

  it('lets a person check a claim once a day', async () => {
    const c = await sentClaim('STS-0002');
    await payerHas(c);
    const now = new Date();
    const ctx = { tenantId: NORTHWIND, claimId: c.id, trigger: 'manual' as const, userId: user };
    expect(await checkClaimStatus(deps(now), ctx)).toMatchObject({ status: 'checked' });
    const again = await checkClaimStatus(deps(new Date(now.getTime() + 3_600_000)), ctx);
    expect(again).toMatchObject({ status: 'refused', reason: 'rate_limited' });
    expect(await checkClaimStatus(deps(new Date(now.getTime() + 25 * 3_600_000)), ctx)).toMatchObject({
      status: 'checked',
    });
  });

  it('gives a task to resubmit a claim the payer has no record of', async () => {
    const c = await sentClaim('STS-0003');
    const res = await checkClaimStatus(deps(new Date()), {
      tenantId: NORTHWIND,
      claimId: c.id,
      trigger: 'manual',
      userId: user,
    });
    expect(res).toMatchObject({ status: 'checked', kind: 'not_found', accepted: false });
    expect((await claimRow(c.id)).status).toBe('submitted');
    const advice = claimStatus.adviseStatus((res as { result: claimStatus.ClaimStatusResult }).result, {
      payerName: 'the payer',
      pmName: 'Tebra',
      paymentArrived: false,
      patientControlNumber: c.patientControlNumber,
    });
    const ctx = { tenantId: NORTHWIND, userId: user, claimId: c.id };
    const made = await createStatusTask(app.db, ctx, { advice });
    expect(made.status).toBe('created');
    const [task] = await admin.db
      .select()
      .from(manualTasks)
      .where(eq(manualTasks.workItemId, (made as { workItemId: string }).workItemId));
    expect(task).toMatchObject({ operation: 'resubmitClaim' });
    expect(task!.instructions.join(' ')).toContain('(control number STS-0003)');
    expect(await createStatusTask(app.db, ctx, { advice })).toEqual({ status: 'refused', reason: 'exists' });
  });

  it('opens a follow-up for no payment a month after acceptance, and closes it when the claim moves on', async () => {
    const c = await sentClaim('STS-0004');
    await withTenant(app.db, { tenantId: NORTHWIND }, (tx) =>
      applyClaimEvent(tx, c, 'accept', { actor: 'automation:test' }),
    );
    const later = new Date(Date.now() + 31 * DAY);
    await statusSweep(app.db, { tenantId: NORTHWIND }, later);
    const [item] = await followUps(c.id);
    expect(item).toMatchObject({ status: 'open', reasonCode: 'no_payment' });
    await withTenant(app.db, { tenantId: NORTHWIND }, async (tx) =>
      applyClaimEvent(tx, { ...c, status: 'accepted' }, 'deny', { actor: 'automation:test' }),
    );
    const sweep = await statusSweep(app.db, { tenantId: NORTHWIND }, later);
    expect(sweep.closed).toBeGreaterThanOrEqual(1);
    expect((await followUps(c.id))[0]).toMatchObject({ status: 'resolved', resolution: 'Claim moved on' });
    const open = await admin.db
      .select()
      .from(workItems)
      .where(
        and(
          eq(workItems.type, 'no_response'),
          ne(workItems.status, 'resolved'),
          inArray(workItems.claimId, [c.id]),
        ),
      );
    expect(open).toHaveLength(0);
  });
});
