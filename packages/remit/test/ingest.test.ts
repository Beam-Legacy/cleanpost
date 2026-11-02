import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claimEvents,
  claimLines,
  claims,
  claimVersions,
  createDatabase,
  encounters,
  patients,
  remitClaims,
  remitLines,
  remittances,
  users,
  withTenant,
  workItems,
} from '@cleanpost/db';
import { testDatabaseUrls } from '@cleanpost/db/testing';
import { createLogger } from '@cleanpost/log';
import { seed } from '@cleanpost/seed';
import { CLIENTS, NORTHWIND } from '@cleanpost/seed/world';
import { parse835 } from '@cleanpost/x12';
import { acceptDifference, ingestRemittance } from '../src';

const urls = testDatabaseUrls();
const admin = createDatabase(urls.adminUrl, { max: 2 });
const app = createDatabase(urls.url, { max: 4 });
const log = createLogger({ name: 'remit-test' });
const deps = { db: app.db, log };
const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'testing', 'golden', '835');
const golden = (name: string) => parse835(readFileSync(join(GOLDEN, name), 'utf8'));
const lakeside = CLIENTS.find((c) => c.name.startsWith('Lakeside'))!;
const willamette = CLIENTS.find((c) => c.name.startsWith('Willamette'))!;

/** A released claim with one line, as sync and release leave it. */
async function sentClaim(
  clientId: string,
  pcn: string,
  code: string,
  chargeCents: number,
  status = 'submitted',
) {
  const [p] = await admin.db
    .insert(patients)
    .values({ tenantId: NORTHWIND, clientId, firstName: 'Avery', lastName: 'Tester', dob: '1980-02-14' })
    .returning();
  const [e] = await admin.db
    .insert(encounters)
    .values({
      tenantId: NORTHWIND,
      clientId,
      patientId: p!.id,
      dateOfService: '2026-10-27',
      status: 'claimed',
    })
    .returning();
  const [c] = await admin.db
    .insert(claims)
    .values({
      tenantId: NORTHWIND,
      clientId,
      patientId: p!.id,
      encounterId: e!.id,
      patientControlNumber: pcn,
      pcnSource: 'pm',
      status,
      mode: 'A',
      totalChargeCents: chargeCents,
      balanceCents: chargeCents,
    })
    .returning();
  const [v] = await admin.db
    .insert(claimVersions)
    .values({
      tenantId: NORTHWIND,
      clientId,
      claimId: c!.id,
      version: 1,
      payload: {},
      createdBy: 'automation:test',
    })
    .returning();
  await admin.db.insert(claimLines).values({
    tenantId: NORTHWIND,
    clientId,
    claimVersionId: v!.id,
    lineNumber: 1,
    lineControlNumber: `${pcn}-1`,
    code,
    chargeCents,
  });
  await admin.db.update(claims).set({ currentVersionId: v!.id }).where(eq(claims.id, c!.id));
  return c!.id;
}

const claimRow = async (id: string) => (await admin.db.select().from(claims).where(eq(claims.id, id)))[0]!;

beforeAll(async () => {
  await seed(admin.db, 'remit-test-password-123');
}, 120_000);

afterAll(async () => {
  await Promise.all([admin.close(), app.close()]);
});

describe('remit.ingest', () => {
  it('matches by control number, marks the claim paid, and links the line exactly', async () => {
    const id = await sentClaim(lakeside.id, 'LFM-E10001', '99213', 14_500);
    // A follow-up from the daily sweep (W-15): the payment answers it.
    const [followUp] = await admin.db
      .insert(workItems)
      .values({
        tenantId: NORTHWIND,
        clientId: lakeside.id,
        type: 'no_response',
        priority: 3,
        dueAt: new Date(Date.now() + 72 * 3_600_000),
        claimId: id,
        reasonCode: 'no_ack',
        summary: 'No acknowledgment from the payer 8 days after it was sent.',
      })
      .returning();
    const res = await ingestRemittance(
      deps,
      { tenantId: NORTHWIND, clientId: lakeside.id, source: 'file' },
      golden('paid-in-full.edi'),
    );
    expect(res).toMatchObject({
      status: 'ingested',
      matched: 1,
      unmatched: 0,
      denied: 0,
      remittanceStatus: 'matched',
    });
    const c = await claimRow(id);
    expect(c).toMatchObject({ status: 'paid', balanceCents: 0 });
    const [rc] = await admin.db.select().from(remitClaims).where(eq(remitClaims.claimId, id));
    expect(rc).toMatchObject({ matchStatus: 'matched', matchedBy: 'pcn', paidCents: 12_000 });
    const [rl] = await admin.db.select().from(remitLines).where(eq(remitLines.remitClaimId, rc!.id));
    expect(rl!.claimLineId).not.toBeNull();
    const events = await admin.db
      .select({ type: claimEvents.type })
      .from(claimEvents)
      .where(eq(claimEvents.claimId, id));
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['ack_277ca', 'paid']));
    const [closed] = await admin.db.select().from(workItems).where(eq(workItems.id, followUp!.id));
    expect(closed).toMatchObject({ status: 'resolved', resolution: 'Payment arrived' });
  });

  it('records a retransmission once and ignores it', async () => {
    const again = await ingestRemittance(
      deps,
      { tenantId: NORTHWIND, clientId: lakeside.id, source: 'file' },
      golden('paid-in-full.edi'),
    );
    expect(again.status).toBe('duplicate');
    expect(
      await admin.db.select().from(remittances).where(eq(remittances.traceNumber, '1EFT0001')),
    ).toHaveLength(1);
  });

  it('denies a claim with CO-197 and opens one auth denial item, priority 1', async () => {
    const id = await sentClaim(willamette.id, 'WOR-E10003', '29881', 44_600, 'accepted');
    const res = await ingestRemittance(
      deps,
      { tenantId: NORTHWIND, clientId: willamette.id, source: 'pm' },
      golden('denied-co197.edi'),
    );
    expect(res).toMatchObject({ status: 'ingested', matched: 1, denied: 1 });
    expect(await claimRow(id)).toMatchObject({ status: 'denied', balanceCents: 44_600 });
    const items = await admin.db
      .select()
      .from(workItems)
      .where(and(eq(workItems.claimId, id), eq(workItems.type, 'denial')));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ priority: 1, summary: 'Denied: CO-197', amountCents: 44_600 });
  });

  it('opens an unmatched item for each payment that matches no claim', async () => {
    const res = await ingestRemittance(
      deps,
      { tenantId: NORTHWIND, clientId: lakeside.id, source: 'file' },
      golden('multiple-claims.edi'),
    );
    expect(res).toMatchObject({
      status: 'ingested',
      matched: 0,
      unmatched: 3,
      remittanceStatus: 'partially_matched',
    });
    const items = await admin.db
      .select()
      .from(workItems)
      .where(and(eq(workItems.type, 'remit_unmatched'), eq(workItems.remittanceId, res.remittanceId)));
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.remitClaimId !== null)).toBe(true);
  });

  it('matches nothing while the 835 does not balance, and says by how much', async () => {
    await sentClaim(lakeside.id, 'LFM-E10011', '99213', 14_500);
    const res = await ingestRemittance(
      deps,
      { tenantId: NORTHWIND, clientId: lakeside.id, source: 'file' },
      golden('out-of-balance.edi'),
    );
    expect(res).toMatchObject({ status: 'out_of_balance' });
    const [r] = await admin.db.select().from(remittances).where(eq(remittances.traceNumber, '1EFT0009'));
    expect(r!.status).toBe('out_of_balance');
    const [item] = await admin.db.select().from(workItems).where(eq(workItems.type, 'out_of_balance'));
    expect(item!.summary).toMatch(/^835 does not balance: off by \$5\.00/);
    const unpaid = await admin.db.select().from(remitClaims).where(eq(remitClaims.remittanceId, r!.id));
    expect(unpaid.every((c) => c.claimId === null)).toBe(true);
  });

  it('goes on once an admin accepts the difference: claims that balance are matched (W-18)', async () => {
    const [r] = await admin.db.select().from(remittances).where(eq(remittances.traceNumber, '1EFT0009'));
    const [u] = await admin.db.select().from(users).where(eq(users.email, 'julia@northwind.test'));
    const res = await withTenant(app.db, { tenantId: NORTHWIND }, (tx) =>
      acceptDifference(
        tx,
        { tenantId: NORTHWIND, userId: u!.id },
        { remittanceId: r!.id, reason: 'Payer confirmed the check amount' },
      ),
    );
    // The claim itself is $5.00 off, so it is set aside; nothing unbalanced reaches a claim.
    expect(res).toMatchObject({ ok: true, matched: 0, unmatched: 0, setAside: 1 });
    const [rc] = await admin.db.select().from(remitClaims).where(eq(remitClaims.remittanceId, r!.id));
    expect(rc).toMatchObject({ matchStatus: 'set_aside', claimId: null });
    const [after] = await admin.db.select().from(remittances).where(eq(remittances.id, r!.id));
    expect(after!.status).not.toBe('out_of_balance');
    const [item] = await admin.db
      .select()
      .from(workItems)
      .where(and(eq(workItems.type, 'out_of_balance'), eq(workItems.remittanceId, r!.id)));
    expect(item).toMatchObject({ status: 'resolved', resolution: 'Difference accepted' });
    expect(
      await withTenant(app.db, { tenantId: NORTHWIND }, (tx) =>
        acceptDifference(
          tx,
          { tenantId: NORTHWIND, userId: u!.id },
          { remittanceId: r!.id, reason: 'again' },
        ),
      ),
    ).toEqual({ ok: false, reason: 'not_out_of_balance' });
  });

  it('pays in part with a deductible: the balance is what the patient owes', async () => {
    const id = await sentClaim(lakeside.id, 'LFM-E10002', '99214', 21_000);
    await admin.db
      .update(claimLines)
      .set({ modifiers: ['25'] })
      .where(eq(claimLines.lineControlNumber, 'LFM-E10002-1'));
    await ingestRemittance(
      deps,
      { tenantId: NORTHWIND, clientId: lakeside.id, source: 'file' },
      golden('partial-deductible.edi'),
    );
    expect(await claimRow(id)).toMatchObject({ status: 'paid', balanceCents: 5000 });
  });
});
