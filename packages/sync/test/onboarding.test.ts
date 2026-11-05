import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clients, connections, encounters, providers } from '@cleanpost/db';
import { apiKeyFor, createPractice, createPracticeBody } from '@cleanpost/pm-mock';
import { readOnboarding } from '@cleanpost/domain';
import { dryRun, goLive, listCandidates, testConnection } from '../src';
import { admin, closeAll, deps, pm, SECRET, seedWorld } from './helpers';

/** O-04 connection test and O-05 dry run against a practice made for the test in the mock PM. */
const NORTHWIND = '01a00000-0000-7000-8000-000000000001';
const CLIENT = '01a00000-0000-7000-8000-0000000c0b01';
const CONN = '01a00000-0000-7000-8000-0000000c0b02';
const KNOWN = '1932204419';
const OTHER = '1768033924';

beforeAll(async () => {
  await seedWorld();
  const made = await createPractice(
    pm.db,
    createPracticeBody.parse({
      name: 'Onboarding Test Practice',
      profile: 'generic',
      providers: [
        { npi: KNOWN, name: 'Dr. Known' },
        { npi: OTHER, name: 'Dr. Not Set Up' },
      ],
      locations: [{ name: 'Main', placeOfService: '11' }],
      payers: [
        { name: 'Aetna', kind: 'commercial' },
        { name: 'Medicare (Noridian JF)', kind: 'medicare' },
      ],
      patients: 15,
      encounters: 25,
      accountId: 'onboarding-test',
      apiKey: apiKeyFor(SECRET, 'onboarding-test'),
    }),
    new Date(),
  );
  await admin.db
    .insert(clients)
    .values({ id: CLIENT, tenantId: NORTHWIND, name: 'Onboarding Test Practice' });
  await admin.db
    .insert(providers)
    .values({ tenantId: NORTHWIND, clientId: CLIENT, npi: KNOWN, name: 'Dr. Known', role: 'rendering' });
  await admin.db.insert(connections).values({
    id: CONN,
    tenantId: NORTHWIND,
    clientId: CLIENT,
    adapterKey: 'mock',
    credentialsSecretRef: 'pm-mock:onboarding-test',
    status: 'setup',
    settings: { pmName: 'Mock PM', profile: 'generic', practiceId: made.practiceId },
  });
});

afterAll(async () => {
  await closeAll();
});

describe('onboarding (O-04, O-05)', () => {
  it('tests the connection: the result is kept on the client; the connection waits in setup', async () => {
    const res = await testConnection(deps(), { tenantId: NORTHWIND, userId: null, connectionId: CONN });
    expect(res.ok).toBe(true);
    const [conn] = await admin.db.select().from(connections).where(eq(connections.id, CONN));
    expect(conn!.status).toBe('setup');
    const [c] = await admin.db.select().from(clients).where(eq(clients.id, CLIENT));
    expect(readOnboarding(c!.onboarding).test).toMatchObject({ ok: true });
  });

  it('dry-runs the last days: counts, payer names and NPIs not set up, and stores no records', async () => {
    const summary = await dryRun(deps(), { tenantId: NORTHWIND, userId: null, clientId: CLIENT }, 120);
    expect(summary).not.toBeNull();
    expect(summary!.patients).toBeGreaterThan(0);
    expect(summary!.encounters).toBeGreaterThan(0);
    expect(summary!.lines).toBeGreaterThanOrEqual(summary!.encounters);
    expect(summary!.payers.map((p) => p.name)).toEqual(expect.arrayContaining(['Aetna']));
    expect(summary!.unknownNpis).toContain(OTHER);
    expect(summary!.unknownNpis).not.toContain(KNOWN);
    const stored = await admin.db.select().from(encounters).where(eq(encounters.clientId, CLIENT));
    expect(stored).toHaveLength(0);
    const [c] = await admin.db.select().from(clients).where(eq(clients.id, CLIENT));
    expect(readOnboarding(c!.onboarding)).toMatchObject({ dryRun: { encounters: summary!.encounters } });
    // Spot-check samples: the PM's encounter numbers, codes and charges; no patient name or date.
    expect(summary!.samples.length).toBe(Math.min(10, summary!.encounters));
    for (const sm of summary!.samples) {
      expect(sm.chargeCents).toBeGreaterThan(0);
      expect(Object.keys(sm).sort()).toEqual(['chargeCents', 'codes', 'encounterId', 'payer']);
    }
  });

  it('is not on the sync schedule until it goes live; Go live puts the connection on it', async () => {
    const before = await listCandidates(admin.db);
    expect(before.map((c) => c.connectionId)).not.toContain(CONN);
    const user = '01a00000-0000-7000-8000-00000000e2e1'; // recorded as the actor only
    const now = new Date();
    const res = await goLive(admin.db, { tenantId: NORTHWIND, userId: user }, CLIENT, now);
    expect(res).toMatchObject({ ok: true, connectionId: CONN });
    const [c] = await admin.db.select().from(clients).where(eq(clients.id, CLIENT));
    expect(c!.status).toBe('live');
    expect(c!.goLiveAt?.getTime()).toBe(now.getTime());
    const [conn] = await admin.db.select().from(connections).where(eq(connections.id, CONN));
    expect(conn!.status).toBe('testing');
    const after = await listCandidates(admin.db);
    expect(after.map((x) => x.connectionId)).toContain(CONN);
    // Only once.
    expect(await goLive(admin.db, { tenantId: NORTHWIND, userId: user }, CLIENT, now)).toEqual({
      ok: false,
      reason: 'invalid_state',
    });
  });
});
