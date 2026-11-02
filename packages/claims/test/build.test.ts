import { and, asc, count, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditEvents,
  chargeLines,
  claimEvents,
  claimLines,
  claims,
  claimVersions,
  clientPayerSettings,
  corrections,
  encounters,
  externalRefs,
  withTenant,
} from '@cleanpost/db';
import { filingDeadline, type ClaimPayload } from '@cleanpost/domain';
import { createRegistry, memoryFileSource, type ChargeCorrection, type PmAdapter } from '@cleanpost/adapters';
import { pmSchema } from '@cleanpost/pm-mock';
import { runSync } from '@cleanpost/sync';
import { scanForPhi } from '@cleanpost/testing';
import { applyClaimEvent, buildClaimsForClient, editClaim } from '../src';
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

let USER = '';

const lakeside = () => client('Lakeside');
const build = (now = new Date()) =>
  buildClaimsForClient(app.db, { tenantId: NORTHWIND, clientId: lakeside().id }, { now });

beforeAll(async () => {
  await syncedWorld();
});

afterAll(async () => {
  await closeAll();
});

describe('claim.build', () => {
  it('builds version 1 for every encounter whose charge entry is complete, and none the PM already sent', async () => {
    const res = await build();
    expect(res.created).toBeGreaterThan(0);
    expect(res.toScrub).toHaveLength(res.created);
    expect(res.skipped.billed_in_pm).toBeGreaterThan(0);

    const built = await admin.db
      .select({ claim: claims, enc: encounters })
      .from(claims)
      .innerJoin(encounters, eq(encounters.id, claims.encounterId))
      .where(eq(claims.clientId, lakeside().id));
    expect(built).toHaveLength(res.created);
    for (const { claim, enc } of built) {
      expect(claim.status).toBe('built');
      expect(claim.mode).toBe('A');
      expect(claim.pcnSource).toBe('pm');
      expect(claim.patientControlNumber).toBeNull();
      expect(['Review', 'Draft']).toContain(enc.pmStatus);
    }
    // Every encounter waiting in Tebra's review has a claim.
    const inReview = await admin.db
      .select({ id: encounters.id })
      .from(encounters)
      .where(and(eq(encounters.clientId, lakeside().id), eq(encounters.pmStatus, 'Review')));
    const claimed = new Set(built.map((b) => b.enc.id));
    expect(inReview.every((e) => claimed.has(e.id))).toBe(true);
  });

  it('copies every charge line and totals in cents, and sets the filing deadline from the payer', async () => {
    const [claim] = await admin.db.select().from(claims).where(eq(claims.clientId, lakeside().id)).limit(1);
    const [enc] = await admin.db.select().from(encounters).where(eq(encounters.id, claim!.encounterId));
    const source = await admin.db.select().from(chargeLines).where(eq(chargeLines.encounterId, enc!.id));
    const lines = await admin.db
      .select()
      .from(claimLines)
      .where(eq(claimLines.claimVersionId, claim!.currentVersionId!));
    expect(lines.map((l) => l.code).sort()).toEqual(source.map((l) => l.code).sort());
    expect(claim!.totalChargeCents).toBe(source.reduce((s, l) => s + l.chargeCents, 0));
    const [settings] = claim!.payerId
      ? await admin.db
          .select()
          .from(clientPayerSettings)
          .where(
            and(
              eq(clientPayerSettings.clientId, lakeside().id),
              eq(clientPayerSettings.payerId, claim!.payerId),
            ),
          )
      : [];
    expect(claim!.filingDeadline).toBe(filingDeadline(enc!.dateOfService, settings?.timelyFilingDays ?? 90));
  });

  it('records the built event with its actor and an audit event, with no PHI in either', async () => {
    const [claim] = await admin.db.select().from(claims).where(eq(claims.clientId, lakeside().id)).limit(1);
    const events = await admin.db.select().from(claimEvents).where(eq(claimEvents.claimId, claim!.id));
    expect(events).toEqual([
      expect.objectContaining({
        type: 'built',
        actor: 'automation:claim.build',
        claimVersionId: claim!.currentVersionId,
      }),
    ]);
    const audits = await admin.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'claim.built'), eq(auditEvents.entityId, claim!.id)));
    expect(audits).toHaveLength(1);
    expect(scanForPhi(JSON.stringify({ events, audits }))).toEqual([]);
  });

  it('builds nothing new on a second run', async () => {
    const before = (await admin.db.select({ n: count() }).from(claimVersions))[0]!.n;
    const res = await build();
    expect(res).toMatchObject({ created: 0, updated: 0 });
    expect(res.unchanged).toBeGreaterThan(0);
    expect((await admin.db.select({ n: count() }).from(claimVersions))[0]!.n).toBe(before);
  });

  it('makes a new version when a pulled change alters an unreleased claim', async () => {
    const [claim] = await admin.db.select().from(claims).where(eq(claims.clientId, lakeside().id)).limit(1);
    const [line] = await admin.db
      .select()
      .from(chargeLines)
      .where(eq(chargeLines.encounterId, claim!.encounterId));
    await admin.db
      .update(chargeLines)
      .set({ units: line!.units + 1 })
      .where(eq(chargeLines.id, line!.id));
    const res = await build();
    expect(res.updated).toBe(1);
    const versions = await admin.db.select().from(claimVersions).where(eq(claimVersions.claimId, claim!.id));
    expect(versions.map((v) => v.version).sort()).toEqual([1, 2]);
    const [after] = await admin.db.select().from(claims).where(eq(claims.id, claim!.id));
    expect(after!.currentVersionId).toBe(versions.find((v) => v.version === 2)!.id);
    expect(after!.status).toBe('built');
  });

  it('leaves a released claim alone, whatever changes in the PM', async () => {
    const [claim] = await admin.db.select().from(claims).where(eq(claims.clientId, lakeside().id)).limit(1);
    await withTenant(app.db, { tenantId: NORTHWIND }, async (tx) => {
      let c = claim!;
      for (const event of ['scrub_review', 'approve', 'release'] as const) {
        const status = await applyClaimEvent(tx, c, event, {
          actor: 'user:01a00000-0000-7000-8000-00000000beef',
        });
        c = { ...c, status };
      }
    });
    const [line] = await admin.db
      .select()
      .from(chargeLines)
      .where(eq(chargeLines.encounterId, claim!.encounterId));
    await admin.db
      .update(chargeLines)
      .set({ units: line!.units + 1 })
      .where(eq(chargeLines.id, line!.id));
    const res = await build();
    expect(res.updated).toBe(0);
    expect(res.skipped.released).toBeGreaterThanOrEqual(1);
  });

  it('refuses transitions the claim machine does not allow', async () => {
    const [claim] = await admin.db
      .select()
      .from(claims)
      .where(and(eq(claims.clientId, lakeside().id), inArray(claims.status, ['built'])))
      .limit(1);
    await expect(
      withTenant(app.db, { tenantId: NORTHWIND }, (tx) =>
        applyClaimEvent(tx, claim!, 'release', { actor: 'automation:test' }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });
});

describe('edits by a person (Mode A, a PM that takes charge corrections)', () => {
  // Lakeside runs the Tebra profile (no correction API); wrap it as a PM that has one.
  const pushed: ChargeCorrection[] = [];
  const base = registry.get('mock');
  const writable: PmAdapter = {
    ...base,
    pushChargeCorrection: async (_conn, correction) => {
      pushed.push(correction);
      return { ok: true };
    },
  };
  const deps = {
    db: app.db,
    registry: createRegistry({ fileSource: memoryFileSource({}), extra: [writable] }),
    log,
  };
  let claimId = '';
  beforeAll(async () => {
    USER = await userIdOf();
  });

  async function pmLines(encounterId: string) {
    const [ref] = await admin.db
      .select()
      .from(externalRefs)
      .where(and(eq(externalRefs.entityId, encounterId), eq(externalRefs.entityType, 'encounter')));
    return pm.db
      .select()
      .from(pmSchema.charges)
      .where(eq(pmSchema.charges.encounterId, ref!.externalId))
      .orderBy(asc(pmSchema.charges.lineNumber));
  }

  async function current(id: string) {
    const [c] = await admin.db.select().from(claims).where(eq(claims.id, id));
    const [v] = await admin.db.select().from(claimVersions).where(eq(claimVersions.id, c!.currentVersionId!));
    return { claim: c!, version: v!, payload: v!.payload as ClaimPayload };
  }

  it('saves an edit as a new version with one corrections row per field, and writes it to the PM', async () => {
    const candidates = await admin.db
      .select()
      .from(claims)
      .where(and(eq(claims.clientId, lakeside().id), eq(claims.status, 'built')))
      .limit(20);
    let picked: Awaited<ReturnType<typeof current>> | null = null;
    for (const c of candidates) {
      const cur = await current(c.id);
      if (
        cur.payload.lines[0] &&
        cur.payload.lines[0].modifiers.length < 3 &&
        !cur.payload.lines[0].modifiers.includes('59')
      ) {
        picked = cur;
        break;
      }
    }
    expect(picked).not.toBeNull();
    claimId = picked!.claim.id;
    const edited: ClaimPayload = structuredClone(picked!.payload);
    edited.lines[0]!.modifiers = [...edited.lines[0]!.modifiers, '59'];
    edited.lines[0]!.units = edited.lines[0]!.units + 1;

    const res = await editClaim(
      deps,
      { tenantId: NORTHWIND, userId: USER, claimId },
      { kind: 'payload', payload: edited },
    );
    expect(res).toMatchObject({ status: 'edited', pm: 'pushed' });
    if (res.status !== 'edited') return;
    expect(res.changes.map((c) => c.fieldPath)).toEqual(['lines[0].modifiers', 'lines[0].units']);

    const after = await current(claimId);
    expect(after.version).toMatchObject({
      version: picked!.version.version + 1,
      createdBy: `user:${USER}`,
      frequencyCode: '1',
    });
    expect(after.claim.status).toBe('built');
    const rows = await admin.db.select().from(corrections).where(eq(corrections.claimId, claimId));
    expect(rows.map((r) => [r.fieldPath, r.userId])).toEqual([
      ['lines[0].modifiers', USER],
      ['lines[0].units', USER],
    ]);
    expect(rows[0]!.after).toEqual(edited.lines[0]!.modifiers);
    const [event] = await admin.db
      .select()
      .from(claimEvents)
      .where(and(eq(claimEvents.claimId, claimId), eq(claimEvents.claimVersionId, after.version.id)));
    expect(event).toMatchObject({ actor: `user:${USER}` });
    const audit = await admin.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.entityId, claimId),
          inArray(auditEvents.action, ['claim.edited', 'claim.correction_pushed']),
        ),
      );
    expect(audit.map((a) => a.action).sort()).toEqual(['claim.correction_pushed', 'claim.edited']);
    expect(scanForPhi(JSON.stringify(audit.map((a) => a.metadata)))).toEqual([]);

    const lines = await pmLines(after.claim.encounterId);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({
      encounterExternalId: lines[0]!.encounterId,
      changes: [
        { lineExternalId: lines[0]!.id, field: 'lines[0].modifiers', to: edited.lines[0]!.modifiers },
        { lineExternalId: lines[0]!.id, field: 'lines[0].units', to: edited.lines[0]!.units },
      ],
    });
  });

  it('keeps the edit through the next build and the next sync', async () => {
    const before = await current(claimId);
    await build(new Date(Date.now() + 86_400_000));
    expect((await current(claimId)).version.id).toBe(before.version.id);
    const conn = await connectionOf('Lakeside');
    const synced = await runSync(
      { db: app.db, registry, log, retryDelaysMs: [10] },
      { tenantId: NORTHWIND, connectionId: conn.id, trigger: 'manual' },
    );
    expect(synced).toMatchObject({ status: 'done' });
    await build(new Date(Date.now() + 86_400_000));
    expect((await current(claimId)).version.id).toBe(before.version.id);
  });

  it('refuses edits to fields that come from the PM, and edits after release', async () => {
    const { payload } = await current(claimId);
    const payer = structuredClone(payload);
    payer.payerId = '01a00000-0000-7000-8000-0000000000a5';
    expect(
      await editClaim(
        deps,
        { tenantId: NORTHWIND, userId: USER, claimId },
        { kind: 'payload', payload: payer },
      ),
    ).toEqual({ status: 'refused', reason: 'locked_field_changed' });
    expect(
      await editClaim(deps, { tenantId: NORTHWIND, userId: USER, claimId }, { kind: 'payload', payload }),
    ).toEqual({ status: 'refused', reason: 'no_change' });
    const [released] = await admin.db
      .select()
      .from(claims)
      .where(and(eq(claims.clientId, lakeside().id), eq(claims.status, 'submitted')))
      .limit(1);
    expect(
      await editClaim(
        deps,
        { tenantId: NORTHWIND, userId: USER, claimId: released!.id },
        { kind: 'fix', ruleIds: ['x'] },
      ),
    ).toEqual({ status: 'refused', reason: 'not_editable' });
  });
});
