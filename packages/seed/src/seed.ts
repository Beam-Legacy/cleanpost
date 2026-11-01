/**
 * Development seed: the synthetic world from ui/CONVENTIONS.md. Synthetic data only.
 * Runs as the system role (it creates tenants, which the apps cannot). Idempotent: fixed IDs.
 * M1 extends this with patients, encounters and charges from @cleanpost/testing generators.
 */
import { eq, sql } from 'drizzle-orm';
import { createAuth, createUserWithPassword } from '@cleanpost/auth';
import type { Database } from '@cleanpost/db';
import { clients, memberships, tenants, users } from '@cleanpost/db';
import { memoryMailer } from '@cleanpost/email';

export const NORTHWIND = '01a00000-0000-7000-8000-000000000001';
export const HARBOR_RCM = '01a00000-0000-7000-8000-000000000002';

const CLIENTS = [
  { id: '01a00000-0000-7000-8000-0000000000c1', name: 'Lakeside Family Medicine', status: 'live', mode: 'A' },
  { id: '01a00000-0000-7000-8000-0000000000c2', name: 'Cascade Pediatrics', status: 'live', mode: 'B' },
  { id: '01a00000-0000-7000-8000-0000000000c3', name: 'Willamette Ortho', status: 'live', mode: 'C' },
  { id: '01a00000-0000-7000-8000-0000000000c4', name: 'Riverbend Counseling', status: 'live', mode: 'A' },
  { id: '01a00000-0000-7000-8000-0000000000c5', name: 'Harbor Dermatology', status: 'onboarding', mode: 'A' },
] as const;
const HARBOR_CLIENT = { id: '01a00000-0000-7000-8000-0000000000d1', name: 'Seaside Physical Therapy' };

interface SeedUser {
  name: string;
  email: string;
  memberships: {
    tenantId: string;
    role: 'admin' | 'biller' | 'viewer';
    isOwner?: boolean;
    clientIds?: string[];
  }[];
}

export const SEED_USERS: SeedUser[] = [
  {
    name: 'Julia Beam',
    email: 'julia@northwind.test',
    memberships: [
      { tenantId: NORTHWIND, role: 'admin', isOwner: true },
      { tenantId: HARBOR_RCM, role: 'admin' },
    ],
  },
  {
    name: 'Priya Shah',
    email: 'priya@northwind.test',
    memberships: [{ tenantId: NORTHWIND, role: 'admin' }],
  },
  {
    name: 'Dana Reyes',
    email: 'dana@northwind.test',
    memberships: [{ tenantId: NORTHWIND, role: 'biller', clientIds: CLIENTS.slice(0, 4).map((c) => c.id) }],
  },
  {
    name: 'Marcus Lee',
    email: 'marcus@northwind.test',
    memberships: [{ tenantId: NORTHWIND, role: 'biller' }],
  },
  {
    name: 'Hana Okoye',
    email: 'hana@harbor-rcm.test',
    memberships: [{ tenantId: HARBOR_RCM, role: 'biller' }],
  },
];

export async function seed(systemDb: Database, password: string): Promise<{ created: string[] }> {
  const created: string[] = [];
  await systemDb
    .insert(tenants)
    .values([
      {
        id: NORTHWIND,
        name: 'Northwind Billing',
        legalName: 'Northwind Billing LLC',
        timezone: 'America/Los_Angeles',
      },
      { id: HARBOR_RCM, name: 'Harbor RCM', legalName: 'Harbor RCM Inc.', timezone: 'America/Los_Angeles' },
    ])
    .onConflictDoNothing();
  await systemDb
    .insert(clients)
    .values([
      ...CLIENTS.map((c) => ({
        id: c.id,
        tenantId: NORTHWIND,
        name: c.name,
        status: c.status,
        defaultMode: c.mode,
      })),
      { id: HARBOR_CLIENT.id, tenantId: HARBOR_RCM, name: HARBOR_CLIENT.name, status: 'live' },
    ])
    .onConflictDoNothing();

  // Users go through better-auth so passwords are hashed exactly as sign-in expects.
  const auth = createAuth({
    db: systemDb,
    mailer: memoryMailer(),
    secret: 'seed-only-secret-not-used-for-sessions',
    appUrl: 'http://localhost:3000',
  });
  for (const u of SEED_USERS) {
    const [existing] = await systemDb.select({ id: users.id }).from(users).where(eq(users.email, u.email));
    const userId =
      existing?.id ?? (await createUserWithPassword(auth, { name: u.name, email: u.email, password })).id;
    if (!existing) created.push(u.email);
    for (const m of u.memberships) {
      await systemDb
        .insert(memberships)
        .values({
          tenantId: m.tenantId,
          userId,
          role: m.role,
          isOwner: m.isOwner ?? false,
          clientScope: m.clientIds ? 'list' : 'all',
          clientIds: m.clientIds ?? sql`'{}'::uuid[]`,
        })
        .onConflictDoNothing();
    }
  }
  return { created };
}
