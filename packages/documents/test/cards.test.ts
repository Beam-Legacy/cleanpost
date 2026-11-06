import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStandInCardReader } from '@cleanpost/ai';
import {
  auditEvents,
  corrections,
  coverages,
  createDatabase,
  decryptField,
  documentBlobs,
  documents,
  encryptField,
  users,
  workItems,
} from '@cleanpost/db';
import { testDatabaseUrls } from '@cleanpost/db/testing';
import { records } from '@cleanpost/domain';
import { createLogger } from '@cleanpost/log';
import { seed } from '@cleanpost/seed';
import { CLIENTS, NORTHWIND, PAYERS } from '@cleanpost/seed/world';
import { scanForPhi } from '@cleanpost/testing';
import {
  cardForReview,
  cardImage,
  cardState,
  confirmCard,
  discardCard,
  extractCard,
  MAX_DOCUMENT_BYTES,
  sniffImage,
  uploadCard,
} from '../src';

/** P-04, P-05, W-14 (DEC-31): synthetic cards only, read by the stand-in. */
const urls = testDatabaseUrls();
const admin = createDatabase(urls.adminUrl, { max: 2 });
const app = createDatabase(urls.url, { max: 4 });
const log = createLogger({ name: 'documents-test' });
const LAKESIDE = CLIENTS[0]!;
const AETNA = PAYERS.find((p) => p.name === 'Aetna')!.id;
const CIGNA = PAYERS.find((p) => p.name === 'Cigna')?.id ?? PAYERS[1]!.id;
const CIGNA_NAME = PAYERS.find((p) => p.id === CIGNA)!.name;
const PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  ),
);
let USER: string;
let patientId: string;
let coverageId: string;
const deps = () => ({ db: app.db, reader: createStandInCardReader(), log });

function card(groupConfidence = 0.97) {
  return records.addPngText(
    PNG,
    records.SYNTHETIC_CARD_KEYWORD,
    records.asciiJson({
      fields: {
        payerName: CIGNA_NAME,
        memberId: 'U4417 7093',
        groupNumber: '3341870',
        subscriberName: 'Ana Quillon',
        planType: 'PPO',
        rxBin: null,
        payerPhone: null,
      },
      confidence: {
        payerName: 0.98,
        memberId: 0.96,
        groupNumber: groupConfidence,
        subscriberName: 0.97,
        planType: 0.95,
        rxBin: null,
        payerPhone: null,
      },
    }),
  );
}

const back = () =>
  records.addPngText(
    PNG,
    records.SYNTHETIC_CARD_KEYWORD,
    records.asciiJson({
      fields: {
        payerName: null,
        memberId: null,
        groupNumber: null,
        subscriberName: null,
        planType: null,
        rxBin: '017010',
        payerPhone: '800-555-0199',
      },
      confidence: {
        payerName: null,
        memberId: null,
        groupNumber: null,
        subscriberName: null,
        planType: null,
        rxBin: 0.93,
        payerPhone: 0.94,
      },
    }),
  );

beforeAll(async () => {
  await seed(admin.db, 'documents-test-password-123');
  const [u] = await admin.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, 'priya@northwind.test'));
  USER = u!.id;
  const p = await admin.db.execute<{ id: string }>(sql`
    insert into patients (tenant_id, client_id, first_name, last_name, dob, sex)
    values (${NORTHWIND}, ${LAKESIDE.id}, 'Ana', 'Quillon', '1984-03-07', 'F') returning id`);
  patientId = p.rows[0]!.id;
  const [c] = await admin.db
    .insert(coverages)
    .values({
      tenantId: NORTHWIND,
      clientId: LAKESIDE.id,
      patientId,
      payerId: AETNA,
      payerName: 'Aetna',
      priority: 1,
      memberIdEncrypted: encryptField('W0000001'),
      memberIdLast4: '0001',
    })
    .returning({ id: coverages.id });
  coverageId = c!.id;
});

afterAll(async () => {
  await Promise.all([admin.close(), app.close()]);
});

describe('insurance cards (P-04, P-05, W-14)', () => {
  it('accepts only images up to 15 MB, by their bytes', async () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImage(new TextEncoder().encode('<svg onload=alert(1)>'))).toBeNull();
    const ctx = { tenantId: NORTHWIND, userId: USER, patientId };
    expect(await uploadCard(app.db, ctx, { front: new TextEncoder().encode('%PDF-1.7') })).toEqual({
      ok: false,
      reason: 'not_an_image',
      side: 'front',
    });
    const big = new Uint8Array(MAX_DOCUMENT_BYTES + 1);
    big.set(PNG);
    expect(await uploadCard(app.db, ctx, { front: PNG, back: big })).toMatchObject({
      ok: false,
      reason: 'too_large',
      side: 'back',
    });
  });

  it('stores the photos encrypted and reads a synthetic card; a real photo is unreadable', async () => {
    const up = await uploadCard(app.db, { tenantId: NORTHWIND, userId: USER, patientId }, { front: PNG });
    expect(up.ok).toBe(true);
    if (!up.ok) return;
    const [blob] = await admin.db.select().from(documentBlobs);
    expect(blob!.contentEncrypted.startsWith('v1:')).toBe(true);
    expect(await extractCard(deps(), { tenantId: NORTHWIND, documentId: up.front })).toEqual({
      status: 'unreadable',
    });
    expect(await cardState(app.db, { tenantId: NORTHWIND, userId: USER, documentId: up.front })).toEqual({
      state: 'unreadable',
      reviewStatus: 'pending',
    });
    expect(await discardCard(app.db, { tenantId: NORTHWIND, userId: USER, documentId: up.front })).toBe(true);
    expect(await admin.db.select().from(documents).where(eq(documents.id, up.front))).toEqual([]);
  });

  it('reads both sides, marks what it was not sure about, and makes a W-14 item for it', async () => {
    const up = await uploadCard(
      app.db,
      { tenantId: NORTHWIND, userId: USER, patientId },
      { front: card(0.82), back: back() },
    );
    if (!up.ok) throw new Error('upload failed');
    expect(await extractCard(deps(), { tenantId: NORTHWIND, documentId: up.front })).toEqual({
      status: 'read',
      review: true,
    });
    expect(await extractCard(deps(), { tenantId: NORTHWIND, documentId: up.back! })).toMatchObject({
      status: 'read',
    });
    // A second run (a job retried) changes nothing.
    expect(await extractCard(deps(), { tenantId: NORTHWIND, documentId: up.front })).toEqual({
      status: 'skipped',
    });
    const view = await cardForReview(app.db, { tenantId: NORTHWIND, userId: USER, documentId: up.front });
    expect(view).toMatchObject({
      state: 'read',
      backDocumentId: up.back,
      matchedPayerId: CIGNA,
      unsure: ['groupNumber'],
      fields: { payerName: CIGNA_NAME, memberId: 'U4417 7093', groupNumber: '3341870', rxBin: '017010' },
    });
    const [doc] = await admin.db.select().from(documents).where(eq(documents.id, up.front));
    // The member ID is encrypted in what was read, like a coverage's; no PHI in the work item.
    expect(JSON.stringify(doc!.extracted)).not.toContain('U4417');
    const items = await admin.db
      .select()
      .from(workItems)
      .where(and(eq(workItems.documentId, up.front), eq(workItems.type, 'card_review')));
    expect(items.map((i) => [i.priority, i.patientId, i.status])).toEqual([[3, patientId, 'open']]);
    expect(scanForPhi(JSON.stringify(items))).toEqual([]);

    // P-05: the person corrects the member ID and confirms; the coverage follows the card.
    const res = await confirmCard(app.db, {
      tenantId: NORTHWIND,
      userId: USER,
      documentId: up.front,
      coverageId,
      fields: { payerId: CIGNA, memberId: 'U44177093', groupNumber: '3341870' },
      checkEligibility: false,
    });
    expect(res).toMatchObject({ ok: true, corrected: ['memberId'], coverageChanged: true });
    const [cov] = await admin.db.select().from(coverages).where(eq(coverages.id, coverageId));
    expect([cov!.payerId, decryptField(cov!.memberIdEncrypted), cov!.groupNumber, cov!.source]).toEqual([
      CIGNA,
      'U44177093',
      '3341870',
      'card',
    ]);
    const docs = await admin.db.select().from(documents).where(eq(documents.patientId, patientId));
    expect(docs.map((d) => d.reviewStatus).sort()).toEqual(['corrected', 'corrected']);
    const [item] = await admin.db.select().from(workItems).where(eq(workItems.id, items[0]!.id));
    expect([item!.status, item!.resolution]).toEqual(['resolved', 'Fields corrected']);
    const fixes = await admin.db.select().from(corrections).where(eq(corrections.entityId, up.front));
    expect(fixes.map((f) => f.fieldPath)).toEqual(['card.memberId']);
    expect(JSON.stringify(fixes)).not.toContain('U4417');
    expect(
      await confirmCard(app.db, {
        tenantId: NORTHWIND,
        userId: USER,
        documentId: up.front,
        coverageId,
        fields: { payerId: CIGNA, memberId: 'U44177093', groupNumber: '3341870' },
        checkEligibility: false,
      }),
    ).toEqual({ ok: false, reason: 'already_confirmed' });

    // Every view of an image is recorded.
    expect(
      await cardImage(app.db, { tenantId: NORTHWIND, userId: USER, documentId: up.front }),
    ).toMatchObject({
      contentType: 'image/png',
    });
    const viewed = await admin.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'document.image_viewed'), eq(auditEvents.entityId, up.front)));
    expect(viewed).toHaveLength(1);
  });

  it('a card read with confidence needs no W-14 item', async () => {
    const up = await uploadCard(
      app.db,
      { tenantId: NORTHWIND, userId: USER, patientId },
      { front: card(0.97) },
    );
    if (!up.ok) throw new Error('upload failed');
    expect(await extractCard(deps(), { tenantId: NORTHWIND, documentId: up.front })).toEqual({
      status: 'read',
      review: false,
    });
  });
});
