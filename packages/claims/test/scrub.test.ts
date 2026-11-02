/**
 * M2 acceptance, end to end on synced mock-PM data: the scrub catches at least 95% of seeded defects
 * with at most 5% false blocks, and routes every claim through the state machine with work items.
 */
import { and, eq, inArray, ne } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chargeLines, claims, claimVersions, externalRefs, scrubResults, workItems } from '@cleanpost/db';
import { pmSchema } from '@cleanpost/pm-mock';
import { seedReference } from '@cleanpost/seed/reference';
import { scanForPhi } from '@cleanpost/testing';
import type { ClaimPayload } from '@cleanpost/domain';
import { buildClaimsForClient, previewScrub, scrubVersion, versionsAwaitingScrub } from '../src';
import { admin, app, client, closeAll, log, NORTHWIND, pm, syncedWorld, userIdOf } from './helpers';

// Each test file owns its practices (Lakeside: build, Willamette: release); files run in any order.
const NAMES = ['Cascade'] as const;
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
    expect(outcomes.size).toBeGreaterThan(25);
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

  it('adds AI concerns as warnings only: a flat 10 points off, never a block', async () => {
    // A fresh version of one clean claim, scrubbed with a reviewer that always raises a concern.
    const [c] = await admin.db
      .select()
      .from(claims)
      .where(and(eq(claims.status, 'needs_review'), inArray(claims.clientId, clientIds())))
      .limit(1);
    const [line] = await admin.db
      .select()
      .from(chargeLines)
      .where(eq(chargeLines.encounterId, c!.encounterId));
    await admin.db
      .update(chargeLines)
      .set({ chargeCents: line!.chargeCents + 100 })
      .where(eq(chargeLines.id, line!.id));
    const built = await buildClaimsForClient(app.db, { tenantId: NORTHWIND, clientId: c!.clientId });
    expect(built.updated).toBe(1);
    const reviewer = {
      review: async () => ({
        summary: 'One point to check.',
        concerns: [
          {
            ruleId: 'ai.test.1',
            step: 'ai' as const,
            severity: 'block' as const,
            field: 'lines[1]',
            message: 'Check it.',
            weight: 0,
          },
        ],
      }),
    };
    const res = await scrubVersion(
      { db: app.db, log, reviewer },
      { tenantId: NORTHWIND, claimVersionId: built.toScrub[0]! },
    );
    // 100 - 20 (first claim) - 2 (eligibility not checked) - 10 (AI concern); the "block" became a warning.
    expect(res).toMatchObject({ status: 'scrubbed', decision: 'review', confidence: 68 });
    const [result] = await admin.db
      .select()
      .from(scrubResults)
      .where(eq(scrubResults.claimVersionId, built.toScrub[0]!));
    expect(result!.aiSummary).toBe('One point to check.');
    const items = (result!.findings as { items: { step: string; severity: string }[] }).items;
    expect(items.find((f) => f.step === 'ai')).toMatchObject({ severity: 'warn' });
  });

  it('scrubs without the AI step when the reviewer fails', async () => {
    const [c] = await admin.db
      .select()
      .from(claims)
      .where(and(eq(claims.status, 'needs_review'), inArray(claims.clientId, clientIds())))
      .limit(1);
    const [line] = await admin.db
      .select()
      .from(chargeLines)
      .where(eq(chargeLines.encounterId, c!.encounterId));
    await admin.db
      .update(chargeLines)
      .set({ chargeCents: line!.chargeCents + 100 })
      .where(eq(chargeLines.id, line!.id));
    const built = await buildClaimsForClient(app.db, { tenantId: NORTHWIND, clientId: c!.clientId });
    const failing = { review: async () => Promise.reject(new Error('Bedrock unavailable')) };
    const res = await scrubVersion(
      { db: app.db, log, reviewer: failing },
      { tenantId: NORTHWIND, claimVersionId: built.toScrub[0]! },
    );
    expect(res).toMatchObject({ status: 'scrubbed', confidence: 78 });
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

  it('previews findings for an unsaved edit without writing anything (C-08)', async () => {
    const [c] = await admin.db
      .select()
      .from(claims)
      .where(and(inArray(claims.clientId, clientIds()), eq(claims.status, 'needs_review')))
      .limit(1);
    const [v] = await admin.db.select().from(claimVersions).where(eq(claimVersions.id, c!.currentVersionId!));
    const payload = v!.payload as ClaimPayload;
    const before = (await admin.db.select({ id: scrubResults.id }).from(scrubResults)).length;
    const ctx = { tenantId: NORTHWIND, userId: await userIdOf(), claimId: c!.id, versionId: v!.id };

    const same = await previewScrub(app.db, ctx, payload);
    expect(same).toMatchObject({ status: 'scored', threshold: 90 });
    // A modifier that does not exist blocks in the preview, as it would in the scrub.
    const bad = structuredClone(payload);
    bad.lines[0]!.modifiers = [...bad.lines[0]!.modifiers.slice(0, 3), 'ZZ'];
    const scored = await previewScrub(app.db, ctx, bad);
    expect(scored).toMatchObject({ status: 'scored', decision: 'blocked' });
    expect(scored.status === 'scored' && scored.findings.map((f) => f.ruleId)).toContain(
      'codes.modifier_invalid',
    );
    // Fields from the PM cannot be changed in the editor.
    const payer = structuredClone(payload);
    payer.payerId = null;
    expect(await previewScrub(app.db, ctx, payer)).toEqual({
      status: 'refused',
      reason: 'locked_field_changed',
    });
    expect(await previewScrub(app.db, { ...ctx, versionId: c!.id }, payload)).toEqual({
      status: 'refused',
      reason: 'stale',
    });
    expect((await admin.db.select({ id: scrubResults.id }).from(scrubResults)).length).toBe(before);
    const [after] = await admin.db.select().from(claims).where(eq(claims.id, c!.id));
    expect(after!.status).toBe('needs_review');
  });
});
