/**
 * M2 acceptance (Mode A side effects): releasing approves the encounter in the mock Tebra PM, the
 * PM's claim status comes back through sync, and a PM that can only release by hand gets exactly one
 * manual task. Runs on Willamette Ortho (Tebra profile); other files own the other practices.
 */
import { and, eq, inArray, ne } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDevSecretResolver,
  createMockAdapter,
  createRegistry,
  memoryFileSource,
  PROFILES,
  type PmAdapter,
} from '@cleanpost/adapters';
import {
  claims,
  claimVersions,
  corrections,
  encounters,
  externalRefs,
  manualTasks,
  rules,
  scrubResults,
  workItems,
} from '@cleanpost/db';
import type { ClaimPayload, Finding } from '@cleanpost/domain';
import { pmSchema } from '@cleanpost/pm-mock';
import { createPgRateLimiter, runSync } from '@cleanpost/sync';
import {
  applyClaimStatuses,
  approveClaim,
  buildClaimsForClient,
  editClaim,
  pushCorrection,
  releaseClaim,
  scrubVersion,
  unapproveClaim,
  versionsAwaitingScrub,
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
  pmApp,
  registry,
  SECRET,
  syncedWorld,
  userIdOf,
} from './helpers';

const willamette = () => client('Willamette');
const USER = '01a00000-0000-7000-8000-00000000b0b0';
const deps = { db: app.db, registry, log };

async function inReview(limit = 1) {
  return admin.db
    .select()
    .from(claims)
    .where(and(eq(claims.clientId, willamette().id), eq(claims.status, 'needs_review')))
    .limit(limit);
}

async function pmEncounterOf(claimId: string) {
  const [c] = await admin.db.select().from(claims).where(eq(claims.id, claimId));
  const [ref] = await admin.db
    .select()
    .from(externalRefs)
    .where(and(eq(externalRefs.entityId, c!.encounterId), eq(externalRefs.entityType, 'encounter')));
  const [e] = await pm.db
    .select()
    .from(pmSchema.encounters)
    .where(eq(pmSchema.encounters.id, ref!.externalId));
  return e!;
}

/** The registry with the mock adapter wrapped to behave like a PM with different release support. */
function registryWith(release: 'manual' | 'unavailable') {
  const base = createMockAdapter({
    baseUrl: 'http://pm-mock.test',
    secrets: createDevSecretResolver({ pmMockSecret: SECRET }),
    limiter: createPgRateLimiter(app.db),
    fetch: ((input: string | URL | Request, init?: RequestInit) =>
      Promise.resolve(pmApp.request(String(input), init))) as typeof fetch,
  });
  const wrapped: PmAdapter = {
    ...base,
    capabilities: async () => ({
      ...PROFILES.tebra,
      releaseCharge: release === 'manual' ? 0 : 'unavailable',
    }),
    releaseCharge: async () => ({
      ok: false,
      retryable: false,
      code: 'UNSUPPORTED',
      message: 'Manual',
      manualTask: {
        operation: 'releaseCharge',
        title: 'Approve the encounter in Tebra',
        instructions: ['Open it.', 'Approve it.'],
      },
    }),
  };
  return createRegistry({ fileSource: memoryFileSource({}), extra: [wrapped] });
}

beforeAll(async () => {
  await syncedWorld();
  await buildClaimsForClient(app.db, { tenantId: NORTHWIND, clientId: willamette().id });
  // A client rule with a one-click fix, so the edit tests below have findings to fix.
  const [first] = await admin.db
    .select({ payload: claimVersions.payload })
    .from(claimVersions)
    .where(eq(claimVersions.clientId, willamette().id))
    .limit(1);
  const code = (first!.payload as ClaimPayload).lines[0]!.code;
  const lineMatch = { codeIn: [code], modifierNotIn: ['59'] };
  await admin.db.insert(rules).values({
    tenantId: NORTHWIND,
    scope: 'client',
    clientId: willamette().id,
    key: 'test.needs_59',
    name: 'Test: modifier 59 on this code',
    kind: 'validate',
    severity: 'warn',
    weight: 15,
    source: 'user',
    condition: { anyLine: lineMatch },
    action: {
      finding: `Add modifier 59 to ${code}.`,
      field: 'lines',
      suggestedFix: { op: 'addModifier', lineMatch, modifier: '59' },
    },
  });
  for (const v of await versionsAwaitingScrub(app.db, NORTHWIND, willamette().id)) {
    await scrubVersion({ db: app.db, log }, { tenantId: NORTHWIND, claimVersionId: v });
  }
}, 240_000);

afterAll(async () => {
  await closeAll();
});

describe('release (Mode A, Tebra profile)', () => {
  it('refuses a claim that is still in review', async () => {
    const [c] = await inReview();
    expect(await releaseClaim(deps, { tenantId: NORTHWIND, claimId: c!.id })).toEqual({
      status: 'refused',
      reason: 'not_ready',
    });
  });

  it('approves in review, then releases by approving the encounter in the PM', async () => {
    const [c] = await inReview();
    expect(await approveClaim(app.db, { tenantId: NORTHWIND, userId: USER, claimId: c!.id })).toEqual({
      ok: true,
    });
    const review = await admin.db
      .select()
      .from(workItems)
      .where(and(eq(workItems.claimId, c!.id), eq(workItems.type, 'claim_review')));
    expect(review.every((w) => w.status === 'resolved' && w.resolvedBy === `user:${USER}`)).toBe(true);

    const res = await releaseClaim(deps, { tenantId: NORTHWIND, claimId: c!.id }, `user:${USER}`);
    expect(res).toEqual({ status: 'released', via: 'adapter' });
    const [after] = await admin.db.select().from(claims).where(eq(claims.id, c!.id));
    expect(after!.status).toBe('submitted');
    const [v] = await admin.db
      .select()
      .from(claimVersions)
      .where(eq(claimVersions.id, after!.currentVersionId!));
    expect(v!.releasedAt).not.toBeNull();
    const [enc] = await admin.db.select().from(encounters).where(eq(encounters.id, after!.encounterId));
    expect(enc!.status).toBe('claimed');
    const pmEnc = await pmEncounterOf(c!.id);
    expect(pmEnc.workflowStatus).toBe('Approved');
    const [pmClaim] = await pm.db
      .select()
      .from(pmSchema.claims)
      .where(eq(pmSchema.claims.encounterId, pmEnc.id));
    expect(pmClaim!.status).toBe('queued');
  });

  it('undoes an approval before release: back in review, item reopened, release refused', async () => {
    const [c] = await inReview();
    const user = await userIdOf();
    await approveClaim(app.db, { tenantId: NORTHWIND, userId: user, claimId: c!.id });
    expect(await unapproveClaim(app.db, { tenantId: NORTHWIND, userId: user, claimId: c!.id })).toEqual({
      ok: true,
    });
    const [after] = await admin.db.select().from(claims).where(eq(claims.id, c!.id));
    expect(after!.status).toBe('needs_review');
    const [review] = await admin.db
      .select()
      .from(workItems)
      .where(and(eq(workItems.claimId, c!.id), eq(workItems.type, 'claim_review')));
    expect(review!.status).toBe('open');
    expect(await releaseClaim(deps, { tenantId: NORTHWIND, claimId: c!.id })).toEqual({
      status: 'refused',
      reason: 'not_ready',
    });
    // Approved again, the approval counts again.
    await approveClaim(app.db, { tenantId: NORTHWIND, userId: user, claimId: c!.id });
    expect(await releaseClaim(deps, { tenantId: NORTHWIND, claimId: c!.id }, `user:${user}`)).toEqual({
      status: 'released',
      via: 'adapter',
    });
    expect(await unapproveClaim(app.db, { tenantId: NORTHWIND, userId: user, claimId: c!.id })).toEqual({
      ok: false,
      reason: 'already_released',
    });
  });

  it('reads the PM claim number and the 277CA result back through sync', async () => {
    const [released] = await admin.db
      .select()
      .from(claims)
      .where(and(eq(claims.clientId, willamette().id), eq(claims.status, 'submitted')))
      .limit(1);
    const pmEnc = await pmEncounterOf(released!.id);
    // The payer accepts it (payer-sim does this in the full cycle).
    await pm.db
      .update(pmSchema.claims)
      .set({ status: 'accepted', updatedAt: new Date() })
      .where(eq(pmSchema.claims.encounterId, pmEnc.id));
    const conn = await connectionOf('Willamette');
    const res = await runSync(
      {
        db: app.db,
        registry,
        log,
        retryDelaysMs: [10],
        appliers: { pullClaimsAndStatus: applyClaimStatuses },
      },
      { tenantId: NORTHWIND, connectionId: conn.id, trigger: 'manual' },
    );
    expect(res).toMatchObject({ status: 'done', connectionStatus: 'healthy' });
    if (res.status === 'done')
      expect(res.operations.map((o) => o.operation)).toContain('pullClaimsAndStatus');
    const [after] = await admin.db.select().from(claims).where(eq(claims.id, released!.id));
    expect(after).toMatchObject({ status: 'accepted', patientControlNumber: pmEnc.id });
  });

  it('turns a 277CA rejection into a rejected claim and one rejection work item', async () => {
    const [c] = await inReview();
    await approveClaim(app.db, { tenantId: NORTHWIND, userId: USER, claimId: c!.id });
    await releaseClaim(deps, { tenantId: NORTHWIND, claimId: c!.id }, `user:${USER}`);
    const pmEnc = await pmEncounterOf(c!.id);
    await pm.db
      .update(pmSchema.claims)
      .set({ status: 'rejected', rejectionReasons: ['Subscriber not found'], updatedAt: new Date() })
      .where(eq(pmSchema.claims.encounterId, pmEnc.id));
    const conn = await connectionOf('Willamette');
    for (let i = 0; i < 2; i++) {
      await runSync(
        {
          db: app.db,
          registry,
          log,
          retryDelaysMs: [10],
          appliers: { pullClaimsAndStatus: applyClaimStatuses },
        },
        { tenantId: NORTHWIND, connectionId: conn.id, trigger: 'manual' },
      );
    }
    const [after] = await admin.db.select().from(claims).where(eq(claims.id, c!.id));
    expect(after!.status).toBe('rejected');
    const items = await admin.db
      .select()
      .from(workItems)
      .where(
        and(eq(workItems.claimId, c!.id), eq(workItems.type, 'rejection'), ne(workItems.status, 'resolved')),
      );
    expect(items).toHaveLength(1);
    expect(items[0]!.summary).toBe('Rejected: Subscriber not found');
  });

  it('creates exactly one manual task when the PM can only release by hand', async () => {
    const [c] = await inReview();
    await approveClaim(app.db, { tenantId: NORTHWIND, userId: USER, claimId: c!.id });
    const manual = { db: app.db, registry: registryWith('manual'), log };
    const first = await releaseClaim(manual, { tenantId: NORTHWIND, claimId: c!.id });
    const second = await releaseClaim(manual, { tenantId: NORTHWIND, claimId: c!.id });
    expect(first.status).toBe('manual_task');
    expect(second).toEqual(first);
    const items = await admin.db
      .select()
      .from(workItems)
      .where(and(eq(workItems.claimId, c!.id), eq(workItems.type, 'manual_task')));
    expect(items).toHaveLength(1);
    const tasks = await admin.db
      .select()
      .from(manualTasks)
      .where(
        inArray(
          manualTasks.workItemId,
          items.map((i) => i.id),
        ),
      );
    expect(tasks).toEqual([
      expect.objectContaining({
        operation: 'releaseCharge',
        status: 'open',
        instructions: ['Open it.', 'Approve it.'],
      }),
    ]);
    const [after] = await admin.db.select().from(claims).where(eq(claims.id, c!.id));
    expect(after!.status).toBe('ready');
  });

  it('submits at once when the PM bills on its own schedule (no hold)', async () => {
    const [c] = await inReview();
    await approveClaim(app.db, { tenantId: NORTHWIND, userId: USER, claimId: c!.id });
    const res = await releaseClaim(
      { db: app.db, registry: registryWith('unavailable'), log },
      { tenantId: NORTHWIND, claimId: c!.id },
    );
    expect(res).toEqual({ status: 'released', via: 'pm_schedule' });
  });
});

describe('edits in Mode A when the PM can only be corrected by hand (Tebra)', () => {
  let user = '';
  let claimId = '';
  let ruleId = '';

  beforeAll(async () => {
    user = await userIdOf();
    // A claim in review whose findings include a one-click fix (missing modifier 25).
    const rows = await admin.db
      .select({ claim: claims, findings: scrubResults.findings })
      .from(claims)
      .innerJoin(claimVersions, eq(claimVersions.id, claims.currentVersionId))
      .innerJoin(scrubResults, eq(scrubResults.id, claimVersions.scrubResultId))
      .where(and(eq(claims.clientId, willamette().id), eq(claims.status, 'needs_review')));
    for (const r of rows) {
      const items = (r.findings as { items: Finding[] }).items;
      const f = items.find((x) => x.suggestedFix?.op === 'addModifier');
      if (f) {
        claimId = r.claim.id;
        ruleId = f.ruleId;
        break;
      }
    }
  });

  async function currentPayload() {
    const [c] = await admin.db.select().from(claims).where(eq(claims.id, claimId));
    const [v] = await admin.db.select().from(claimVersions).where(eq(claimVersions.id, c!.currentVersionId!));
    return { claim: c!, version: v!, payload: v!.payload as ClaimPayload };
  }

  async function openCorrectionItems() {
    return admin.db
      .select()
      .from(workItems)
      .where(
        and(
          eq(workItems.claimId, claimId),
          eq(workItems.reasonCode, 'pushChargeCorrection'),
          ne(workItems.status, 'resolved'),
        ),
      );
  }

  it('applies a suggested fix as a new version and opens one correction task with a worksheet', async () => {
    expect(claimId).not.toBe('');
    const res = await editClaim(
      app.db,
      { tenantId: NORTHWIND, userId: user, claimId },
      { kind: 'fix', ruleIds: [ruleId] },
    );
    expect(res).toMatchObject({ status: 'edited', writeBack: true });
    if (res.status !== 'edited') return;
    expect(await pushCorrection(deps, { tenantId: NORTHWIND, claimId })).toMatchObject({
      status: 'manual_task',
      version: res.version,
    });
    expect(res.changes.map((c) => c.label)).toEqual([expect.stringMatching(/^Line \d modifier 59 added$/)]);
    const items = await openCorrectionItems();
    expect(items).toHaveLength(1);
    const [task] = await admin.db.select().from(manualTasks).where(eq(manualTasks.workItemId, items[0]!.id));
    expect(task!.title).toBe('Correct the encounter in Tebra');
    expect(task!.instructions.at(-1)).toMatch(/^Worksheet: Line \d modifier 59 added\.$/);
    expect(task!.payloadRef).toBe(`claim_version:${res.versionId}`);
    const rows = await admin.db.select().from(corrections).where(eq(corrections.claimId, claimId));
    expect(rows).toHaveLength(1);
  });

  it('keeps one task as more edits come, with every change on its worksheet', async () => {
    const { payload } = await currentPayload();
    const next = structuredClone(payload);
    next.priorAuthNumber = 'PA20261101';
    const res = await editClaim(
      app.db,
      { tenantId: NORTHWIND, userId: user, claimId },
      { kind: 'payload', payload: next },
    );
    expect(res).toMatchObject({ status: 'edited', writeBack: true });
    expect(await pushCorrection(deps, { tenantId: NORTHWIND, claimId })).toMatchObject({
      status: 'manual_task',
    });
    const items = await openCorrectionItems();
    expect(items).toHaveLength(1);
    const [task] = await admin.db.select().from(manualTasks).where(eq(manualTasks.workItemId, items[0]!.id));
    expect(task!.instructions.filter((i) => i.startsWith('Worksheet:'))).toHaveLength(2);
  });

  it('does not release while the correction is still to be made in the PM', async () => {
    const { version } = await currentPayload();
    await scrubVersion({ db: app.db, log }, { tenantId: NORTHWIND, claimVersionId: version.id });
    const { claim } = await currentPayload();
    if (claim.status === 'needs_review')
      await approveClaim(app.db, { tenantId: NORTHWIND, userId: user, claimId });
    expect((await currentPayload()).claim.status).toBe('ready');
    expect(await releaseClaim(deps, { tenantId: NORTHWIND, claimId }, `user:${user}`)).toEqual({
      status: 'refused',
      reason: 'pm_correction_pending',
    });
  });

  it('resolves the task and releases once a sync shows the change in the PM', async () => {
    const { claim, payload, version } = await currentPayload();
    // The biller makes the change in Tebra.
    const pmEnc = await pmEncounterOf(claimId);
    const lines = await pm.db
      .select()
      .from(pmSchema.charges)
      .where(eq(pmSchema.charges.encounterId, pmEnc.id));
    const [ref] = await admin.db
      .select()
      .from(externalRefs)
      .where(and(eq(externalRefs.entityId, claim.encounterId), eq(externalRefs.entityType, 'encounter')));
    expect(ref).toBeDefined();
    for (const l of payload.lines) {
      const pmLine = lines.find((x) => x.lineNumber === l.lineNumber)!;
      await pm.db
        .update(pmSchema.charges)
        .set({ modifiers: l.modifiers, units: l.units })
        .where(eq(pmSchema.charges.id, pmLine.id));
    }
    await pm.db
      .update(pmSchema.encounters)
      .set({ priorAuthNumber: payload.priorAuthNumber, updatedAt: new Date() })
      .where(eq(pmSchema.encounters.id, pmEnc.id));
    const conn = await connectionOf('Willamette');
    await runSync(
      {
        db: app.db,
        registry,
        log,
        retryDelaysMs: [10],
        appliers: { pullClaimsAndStatus: applyClaimStatuses },
      },
      { tenantId: NORTHWIND, connectionId: conn.id, trigger: 'manual' },
    );
    const built = await buildClaimsForClient(
      app.db,
      { tenantId: NORTHWIND, clientId: willamette().id },
      { quietPeriodMinutes: 0 },
    );
    expect(built.toRelease).toContain(claimId);
    expect((await currentPayload()).version.id).toBe(version.id);
    expect(await openCorrectionItems()).toHaveLength(0);
    const [resolved] = await admin.db
      .select()
      .from(workItems)
      .where(and(eq(workItems.claimId, claimId), eq(workItems.reasonCode, 'pushChargeCorrection')));
    expect(resolved).toMatchObject({ status: 'resolved', resolvedBy: 'automation:claim.build' });
    expect(await releaseClaim(deps, { tenantId: NORTHWIND, claimId }, `user:${user}`)).toEqual({
      status: 'released',
      via: 'adapter',
    });
  });
});
