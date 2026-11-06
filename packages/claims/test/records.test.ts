/**
 * DEC-30 on synced mock-PM data: an eligibility-only block is a W-13 item; P-02 and P-06 corrections
 * are kept in Cleanpost with one PM task per patient, hold release until the PM shows them, and the
 * sync closes the task when it does (or opens a conflict task when it does not and nobody has one).
 */
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditEvents,
  claimEvents,
  claims,
  corrections,
  coverages,
  decryptField,
  eligibilityChecks,
  externalRefs,
  manualTasks,
  patients,
  payers,
  workItems,
} from '@cleanpost/db';
import { pmSchema } from '@cleanpost/pm-mock';
import { seedReference } from '@cleanpost/seed/reference';
import { runSync } from '@cleanpost/sync';
import {
  approveClaim,
  buildClaimsForClient,
  editCoverage,
  editPatient,
  RECORD_WAIT_EVENT,
  recordPending,
  releaseClaim,
  rescrubForCoverage,
  scrubVersion,
  versionsAwaitingScrub,
} from '../src';
import { withTenant } from '@cleanpost/db';
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

const cascade = () => client('Cascade');
let USER: string;
let claimId: string;
let coverageId: string;
let patientId: string;

async function scrubAll(versionIds: string[]) {
  for (const claimVersionId of versionIds)
    await scrubVersion({ db: app.db, log }, { tenantId: NORTHWIND, claimVersionId });
}

async function check(status: 'active' | 'inactive') {
  await admin.db.insert(eligibilityChecks).values({
    tenantId: NORTHWIND,
    clientId: cascade().id,
    coverageId,
    status,
    summary: {},
  });
}

async function sync() {
  const conn = await connectionOf('Cascade');
  const res = await runSync(
    { db: app.db, registry, log, retryDelaysMs: [10] },
    { tenantId: NORTHWIND, connectionId: conn.id, trigger: 'manual' },
  );
  expect(res.status).toBe('done');
}

const openTasks = (operation: string) =>
  admin.db
    .select()
    .from(workItems)
    .where(
      and(
        eq(workItems.patientId, patientId),
        eq(workItems.reasonCode, operation),
        eq(workItems.type, 'manual_task'),
        ne(workItems.status, 'resolved'),
      ),
    );

beforeAll(async () => {
  await syncedWorld();
  await seedReference(admin.db);
  USER = await userIdOf('priya@northwind.test');
  await buildClaimsForClient(app.db, { tenantId: NORTHWIND, clientId: cascade().id });
  await scrubAll(await versionsAwaitingScrub(app.db, NORTHWIND, cascade().id));
  // A claim not yet sent whose patient has one coverage, so the payer stays the claim's.
  const rows = await admin.db
    .select({ id: claims.id, coverageId: claims.coverageId, patientId: claims.patientId })
    .from(claims)
    .where(and(eq(claims.clientId, cascade().id), inArray(claims.status, ['needs_review', 'ready'])));
  for (const r of rows) {
    if (!r.coverageId) continue;
    const covs = await admin.db.select().from(coverages).where(eq(coverages.patientId, r.patientId));
    const others = await admin.db
      .select({ id: claims.id })
      .from(claims)
      .where(and(eq(claims.patientId, r.patientId), ne(claims.id, r.id)));
    if (covs.length === 1 && others.length === 0) {
      claimId = r.id;
      coverageId = r.coverageId;
      patientId = r.patientId;
      break;
    }
  }
  expect(claimId).toBeDefined();
}, 240_000);

afterAll(async () => {
  await closeAll();
});

describe('W-13 and record corrections (DEC-30)', () => {
  it('makes a claim held only by its coverage an eligibility issue about the patient, priority 1', async () => {
    await check('inactive');
    await scrubAll(await rescrubForCoverage(app.db, { tenantId: NORTHWIND, userId: USER, coverageId }));
    const [c] = await admin.db.select().from(claims).where(eq(claims.id, claimId));
    expect(c!.status).toBe('blocked');
    const items = await admin.db
      .select()
      .from(workItems)
      .where(and(eq(workItems.claimId, claimId), ne(workItems.status, 'resolved')));
    expect(items.map((i) => [i.type, i.priority, i.patientId, i.reasonCode])).toEqual([
      ['eligibility_issue', 1, patientId, 'eligibility.inactive'],
    ]);
  });

  it('saves a coverage correction in Cleanpost with one task for the PM, and never logs the values', async () => {
    const [before] = await admin.db.select().from(coverages).where(eq(coverages.id, coverageId));
    const res = await editCoverage(app.db, {
      tenantId: NORTHWIND,
      userId: USER,
      coverageId,
      edit: {
        payerId: before!.payerId!,
        memberId: 'zq90017733',
        groupNumber: before!.groupNumber ?? '',
        relationship: before!.relationship as 'self',
        priority: before!.priority,
        effectiveDate: before!.effectiveDate ?? '',
        terminationDate: before!.terminationDate ?? '',
        checkEligibility: false,
      },
    });
    expect(res).toMatchObject({ ok: true, fields: ['memberId'] });
    const [after] = await admin.db.select().from(coverages).where(eq(coverages.id, coverageId));
    expect(after!.source).toBe('user');
    expect(after!.memberIdLast4).toBe('7733');
    expect(decryptField(after!.memberIdEncrypted)).toBe('ZQ90017733');
    const [task] = await openTasks('updateCoverage');
    expect(task!.summary).toMatch(/^Update .+ coverage in /);
    const [mt] = await admin.db.select().from(manualTasks).where(eq(manualTasks.workItemId, task!.id));
    expect(mt!.instructions[0]).toMatch(/change the member ID\.$/);
    expect(JSON.stringify(mt)).not.toContain('ZQ90017733');
    const rows = await admin.db.select().from(corrections).where(eq(corrections.entityId, coverageId));
    expect(rows.map((r) => [r.entityType, r.fieldPath, r.workItemId])).toEqual([
      ['coverage', 'coverage.memberId', task!.id],
    ]);
    expect(JSON.stringify(rows)).not.toContain('ZQ90017733');
    const [audit] = await admin.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'coverage.updated'), eq(auditEvents.entityId, coverageId)));
    expect(audit!.metadata).toEqual({ fields: ['memberId'], via: 'P-02' });

    // A second correction joins the same task, which now names both fields.
    const again = await editCoverage(app.db, {
      tenantId: NORTHWIND,
      userId: USER,
      coverageId,
      edit: {
        payerId: before!.payerId!,
        groupNumber: 'GRP-55',
        relationship: before!.relationship as 'self',
        priority: before!.priority,
        effectiveDate: before!.effectiveDate ?? '',
        terminationDate: before!.terminationDate ?? '',
        checkEligibility: false,
      },
    });
    expect(again).toMatchObject({ ok: true, fields: ['groupNumber'], taskItemId: task!.id });
    const tasks = await openTasks('updateCoverage');
    expect(tasks).toHaveLength(1);
    const [mt2] = await admin.db.select().from(manualTasks).where(eq(manualTasks.workItemId, task!.id));
    expect(mt2!.instructions[0]).toMatch(/change the member ID and group number\.$/);
  });

  it('holds release while the PM does not show the correction', async () => {
    await check('active');
    await scrubAll(await rescrubForCoverage(app.db, { tenantId: NORTHWIND, userId: USER, coverageId }));
    let [c] = await admin.db.select().from(claims).where(eq(claims.id, claimId));
    if (c!.status === 'needs_review')
      await approveClaim(app.db, { tenantId: NORTHWIND, claimId, userId: USER });
    [c] = await admin.db.select().from(claims).where(eq(claims.id, claimId));
    expect(c!.status).toBe('ready');
    expect(await withTenant(app.db, { tenantId: NORTHWIND }, (tx) => recordPending(tx, claimId))).toBe(true);
    const res = await releaseClaim({ db: app.db, registry, log }, { tenantId: NORTHWIND, claimId });
    expect(res).toEqual({ status: 'refused', reason: 'pm_record_pending' });
    const waited = await admin.db
      .select()
      .from(claimEvents)
      .where(and(eq(claimEvents.claimId, claimId), eq(claimEvents.type, RECORD_WAIT_EVENT)));
    expect(waited).toHaveLength(1);
  });

  it('keeps the correction through a sync that still shows the old values, then closes the task when the PM catches up', async () => {
    await sync();
    const [still] = await admin.db.select().from(coverages).where(eq(coverages.id, coverageId));
    expect(still!.source).toBe('user');
    expect(decryptField(still!.memberIdEncrypted)).toBe('ZQ90017733');
    expect(await openTasks('updateCoverage')).toHaveLength(1);

    // Someone makes the change in the PM.
    const [ref] = await admin.db
      .select({ externalId: externalRefs.externalId })
      .from(externalRefs)
      .where(and(eq(externalRefs.entityType, 'coverage'), eq(externalRefs.entityId, coverageId)));
    const [policy] = await pm.db
      .update(pmSchema.policies)
      .set({ memberId: 'ZQ90017733', groupNumber: 'GRP-55' })
      .where(eq(pmSchema.policies.id, ref!.externalId))
      .returning();
    // The PM pages patients by their last change; a policy change touches the patient.
    await pm.db
      .update(pmSchema.patients)
      .set({ updatedAt: new Date() })
      .where(eq(pmSchema.patients.id, policy!.patientId));
    await sync();
    const [now] = await admin.db.select().from(coverages).where(eq(coverages.id, coverageId));
    expect(now!.source).toBe('pm');
    expect(await openTasks('updateCoverage')).toHaveLength(0);
    const [done] = await admin.db
      .select()
      .from(workItems)
      .where(and(eq(workItems.patientId, patientId), eq(workItems.reasonCode, 'updateCoverage')))
      .orderBy(desc(workItems.updatedAt));
    expect(done!.resolution).toBe('PM updated');
    // The next build releases the claim that waited.
    const built = await buildClaimsForClient(app.db, { tenantId: NORTHWIND, clientId: cascade().id });
    expect(built.toRelease).toContain(claimId);
  });

  it('opens a conflict task when the PM still differs and nobody has the task', async () => {
    const [p] = await admin.db.select().from(patients).where(eq(patients.id, patientId));
    const res = await editPatient(app.db, {
      tenantId: NORTHWIND,
      userId: USER,
      patientId,
      edit: {
        firstName: p!.firstName,
        lastName: p!.lastName,
        dob: p!.dob,
        sex: p!.sex as 'F',
        phone: '(503) 555-0142',
      },
    });
    expect(res).toMatchObject({ ok: true, fields: expect.arrayContaining(['phone']) });
    const [task] = await openTasks('updatePatient');
    // A person closes the task without changing the PM.
    await admin.db
      .update(workItems)
      .set({ status: 'resolved', resolution: 'Other', resolvedAt: new Date() })
      .where(eq(workItems.id, task!.id));
    await sync();
    const [after] = await admin.db.select().from(patients).where(eq(patients.id, patientId));
    expect(after!.source).toBe('user');
    expect(after!.phone).toBe('(503) 555-0142');
    const conflict = await openTasks('updatePatient');
    expect(conflict).toHaveLength(1);
    expect(conflict[0]!.summary).toMatch(/still shows the old patient details$/);
  });

  it('builds a new version with the new payer when the payer is corrected', async () => {
    const [cov] = await admin.db.select().from(coverages).where(eq(coverages.id, coverageId));
    const [other] = await admin.db.select().from(payers).where(ne(payers.id, cov!.payerId!)).limit(1);
    const before = await admin.db.select().from(claims).where(eq(claims.id, claimId));
    expect(before[0]!.status).toBe('ready');
    const res = await editCoverage(app.db, {
      tenantId: NORTHWIND,
      userId: USER,
      coverageId,
      edit: {
        payerId: other!.id,
        relationship: cov!.relationship as 'self',
        priority: cov!.priority,
        checkEligibility: false,
      },
    });
    expect(res).toMatchObject({ ok: true });
    if (!res.ok) return;
    expect(res.fields).toContain('payerId');
    expect(res.versionIds).toHaveLength(1);
    const [c] = await admin.db.select().from(claims).where(eq(claims.id, claimId));
    expect(c!.payerId).toBe(other!.id);
    expect(c!.status).toBe('built');
  });
});
