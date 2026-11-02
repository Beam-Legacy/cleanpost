import { and, count, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditEvents,
  chargeLines,
  claimEvents,
  claimLines,
  claims,
  claimVersions,
  clientPayerSettings,
  encounters,
  withTenant,
} from '@cleanpost/db';
import { filingDeadline } from '@cleanpost/domain';
import { scanForPhi } from '@cleanpost/testing';
import { applyClaimEvent, buildClaimsForClient } from '../src';
import { admin, app, client, closeAll, NORTHWIND, syncedWorld } from './helpers';

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
