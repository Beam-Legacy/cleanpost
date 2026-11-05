import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiKeyFor } from '../src/keys';
import { adminAuth, handle, SECRET, seedTestWorld, testApp } from './helpers';

/** Onboarding demo (O-04): a new practice in the mock PM, reachable with the caller's derived key. */
const app = testApp();

beforeAll(async () => {
  await seedTestWorld();
});

afterAll(async () => {
  await handle.close();
});

const body = (accountId: string) => ({
  name: 'Harbor Dermatology',
  profile: 'tebra',
  providers: [{ npi: '1932204419', name: 'Dr. Naomi Castellanos' }],
  locations: [{ name: 'Harbor Dermatology', placeOfService: '11' }],
  payers: [
    { name: 'Aetna', kind: 'commercial' },
    { name: 'Medicare (Noridian JF)', kind: 'medicare' },
  ],
  patients: 12,
  encounters: 20,
  accountId,
  apiKey: apiKeyFor(SECRET, accountId),
});

describe('creating a practice (admin)', () => {
  it('needs the admin password and a valid body', async () => {
    expect((await app.request('/admin/api/practices', { method: 'POST', body: '{}' })).status).toBe(401);
    const bad = await app.request('/admin/api/practices', {
      method: 'POST',
      headers: { ...adminAuth, 'content-type': 'application/json' },
      body: JSON.stringify({ ...body('harbor-test'), providers: [] }),
    });
    expect(bad.status).toBe(422);
  });

  it('creates the account, practice and synthetic visits; the derived key reads it; listed after', async () => {
    const res = await app.request('/admin/api/practices', {
      method: 'POST',
      headers: { ...adminAuth, 'content-type': 'application/json' },
      body: JSON.stringify(body('harbor-test')),
    });
    expect(res.status).toBe(200);
    const created = (await res.json()) as {
      practiceId: string;
      locations: { id: string }[];
      encounters: number;
    };
    expect(created.practiceId).toMatch(/^harbor-dermatology-[0-9a-f]{4}$/);
    expect(created.encounters).toBe(20);
    expect(created.locations).toHaveLength(1);

    const read = await app.request(`/api/v1/practices/${created.practiceId}`, {
      headers: { authorization: `Bearer ${apiKeyFor(SECRET, 'harbor-test')}` },
    });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ id: created.practiceId, profile: 'tebra' });

    const list = await app.request('/admin/api/practices', { headers: adminAuth });
    const { practices } = (await list.json()) as { practices: { id: string; encounters: number }[] };
    expect(practices.find((p) => p.id === created.practiceId)?.encounters).toBe(20);

    const again = await app.request('/admin/api/practices', {
      method: 'POST',
      headers: { ...adminAuth, 'content-type': 'application/json' },
      body: JSON.stringify(body('harbor-test')),
    });
    expect(again.status).toBe(409);
  });
});
