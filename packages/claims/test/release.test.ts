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
import { claims, claimVersions, encounters, externalRefs, manualTasks, workItems } from '@cleanpost/db';
import { pmSchema } from '@cleanpost/pm-mock';
import { createPgRateLimiter, runSync } from '@cleanpost/sync';
import {
  applyClaimStatuses,
  approveClaim,
  buildClaimsForClient,
  releaseClaim,
  scrubVersion,
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
