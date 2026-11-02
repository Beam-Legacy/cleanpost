/**
 * M2 acceptance, end to end on synced mock-PM data: the scrub catches at least 95% of seeded defects
 * with at most 5% false blocks, and routes every claim through the state machine with work items.
 */
import { and, eq, inArray, ne } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claims, claimVersions, externalRefs, scrubResults, workItems } from '@cleanpost/db';
import { pmSchema } from '@cleanpost/pm-mock';
import { seedReference } from '@cleanpost/seed/reference';
import { scanForPhi } from '@cleanpost/testing';
import { buildClaimsForClient, scrubVersion, versionsAwaitingScrub } from '../src';
import { admin, app, client, closeAll, log, NORTHWIND, pm, syncedWorld } from './helpers';

// Lakeside belongs to the build tests; files run in any order against one database.
const NAMES = ['Willamette', 'Cascade'] as const;
const clientIds = () => NAMES.map((n) => client(n).id);
const outcomes = new Map<string, { decision: string; confidence: number }>();

beforeAll(async () => {
  await syncedWorld();
  await seedReference(admin.db);
  for (const name of NAMES) {
    await buildClaimsForClient(app.db, { tenantId: NORTHWIND, clientId: client(name).id });
    // Includes claims an earlier test file built and left unscrubbed.
    for (const versionId of await versionsAwaitingScrub(app.db, NORTHWIND, client(name).id)) {
      const res = await scrubVersion({ db: app.db, log }, { tenantId: NORTHWIND, claimVersionId: versionId });
      if (res.status === 'scrubbed') outcomes.set(versionId, res);
    }
  }
}, 240_000);

afterAll(async () => {
  await closeAll();
});

describe('claim.scrub on synced data', () => {
  it('scrubs every built claim and moves it through the state machine', async () => {
    expect(outcomes.size).toBeGreaterThan(30);
    const rows = await admin.db
      .select({ status: claims.status })
      .from(claims)
      .where(inArray(claims.clientId, clientIds()));
    expect(rows.every((r) => ['ready', 'needs_review', 'blocked'].includes(r.status))).toBe(true);
  });

  it('catches at least 95% of seeded defects with at most 5% false blocks', async () => {
    const key = await pm.db
      .select()
      .from(pmSchema.answerKey)
      .where(eq(pmSchema.answerKey.recordType, 'encounter'));
    const defective = new Set(key.map((k) => k.recordId));
    const rows = await admin.db
      .select({ status: claims.status, externalId: externalRefs.externalId })
      .from(claims)
      .innerJoin(
        externalRefs,
        and(eq(externalRefs.entityId, claims.encounterId), eq(externalRefs.entityType, 'encounter')),
      )
      .where(inArray(claims.clientId, clientIds()));
    const withDefect = rows.filter((r) => defective.has(r.externalId));
    const clean = rows.filter((r) => !defective.has(r.externalId));
    expect(withDefect.length).toBeGreaterThan(0);
    const caught = withDefect.filter((r) => r.status === 'blocked').length;
    const falseBlocks = clean.filter((r) => r.status === 'blocked').length;
    expect(caught / withDefect.length).toBeGreaterThanOrEqual(0.95);
    expect(falseBlocks / clean.length).toBeLessThanOrEqual(0.05);
  });

  it('sends clean claims to review at 78 while the client-payer pair has no history (docs/06)', async () => {
    const clean = [...outcomes.values()].filter((o) => o.decision !== 'blocked');
    expect(clean.length).toBeGreaterThan(0);
    // 100 - 20 (first claim for this client and payer) - 2 (eligibility not checked yet)
    expect(clean.every((o) => o.decision === 'review' && o.confidence === 78)).toBe(true);
  });

  it('opens one work item per review or blocked claim, of the right type', async () => {
    const open = await admin.db
      .select({ type: workItems.type, claimId: workItems.claimId })
      .from(workItems)
      .where(
        and(inArray(workItems.type, ['claim_review', 'claim_blocked']), ne(workItems.status, 'resolved')),
      );
    const statuses = await admin.db
      .select({ id: claims.id, status: claims.status })
      .from(claims)
      .where(
        and(
          inArray(claims.status, ['needs_review', 'blocked', 'ready']),
          inArray(claims.clientId, clientIds()),
        ),
      );
    for (const c of statuses) {
      const items = open.filter((o) => o.claimId === c.id);
      if (c.status === 'ready') {
        expect(items).toEqual([]);
        continue;
      }
      expect(items).toHaveLength(1);
      expect(items[0]!.type).toBe(c.status === 'blocked' ? 'claim_blocked' : 'claim_review');
    }
  });

  it('stores findings with fields and suggested fixes, and no PHI anywhere', async () => {
    const results = await admin.db.select().from(scrubResults);
    const items = await admin.db.select({ summary: workItems.summary }).from(workItems);
    const blockedFix = results
      .flatMap((r) => (r.findings as { items: { suggestedFix?: unknown; severity: string }[] }).items)
      .find((f) => f.severity === 'block' && f.suggestedFix);
    expect(blockedFix).toBeDefined();
    expect(scanForPhi(JSON.stringify({ results, items }))).toEqual([]);
  });

  it('skips a claim that has already been scrubbed, and a version that is no longer current', async () => {
    const [c] = await admin.db
      .select()
      .from(claims)
      .where(and(eq(claims.status, 'needs_review'), inArray(claims.clientId, clientIds())))
      .limit(1);
    expect(
      await scrubVersion({ db: app.db, log }, { tenantId: NORTHWIND, claimVersionId: c!.currentVersionId! }),
    ).toEqual({ status: 'skipped', reason: 'not_built' });
    const versions = await admin.db.select().from(claimVersions);
    const old = versions.find(
      (v) => v.version === 1 && versions.some((w) => w.claimId === v.claimId && w.version === 2),
    );
    if (old) {
      expect(
        await scrubVersion({ db: app.db, log }, { tenantId: NORTHWIND, claimVersionId: old.id }),
      ).toEqual({
        status: 'skipped',
        reason: 'stale',
      });
    }
  });

  it('records why each claim scored what it did', async () => {
    const [r] = await admin.db
      .select()
      .from(scrubResults)
      .where(eq(scrubResults.decision, 'review'))
      .limit(1);
    expect((r!.findings as { deductions: { reason: string }[] }).deductions.map((d) => d.reason)).toEqual(
      expect.arrayContaining(['first_claim_for_client_payer', 'eligibility.not_checked']),
    );
    expect(r!.rulesVersion).toMatch(/^rules-[0-9a-f]{12}$/);
  });
});
