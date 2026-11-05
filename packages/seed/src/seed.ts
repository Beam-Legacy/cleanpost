/**
 * Development and preview seed: the synthetic world from ui/CONVENTIONS.md (src/world.ts).
 * Runs as the system role because it creates tenants, which the apps cannot. Idempotent: fixed IDs
 * and natural keys, so it runs on every preview deploy.
 */
import { and, eq, sql } from 'drizzle-orm';
import { PROFILES } from '@cleanpost/adapters';
import { createAuth, createUserWithPassword } from '@cleanpost/auth';
import type { Database } from '@cleanpost/db';
import {
  clientPayerSettings,
  clients,
  connections,
  encryptField,
  last4,
  externalRefs,
  locations,
  memberships,
  payers,
  providers,
  tenants,
  users,
} from '@cleanpost/db';
import { memoryMailer } from '@cleanpost/email';
import { seedReference } from './reference';
import {
  CLIENTS,
  HARBOR_RCM,
  NORTHWIND,
  PAYERS,
  SIM_PAYER_IDS,
  npi,
  pmLocationId,
  pmMockSecretRef,
} from './world';

export { HARBOR_RCM, NORTHWIND } from './world';

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

const NW_CLIENT_IDS = CLIENTS.filter((c) => c.tenantId === NORTHWIND).map((c) => c.id);

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
    memberships: [{ tenantId: NORTHWIND, role: 'biller', clientIds: NW_CLIENT_IDS.slice(0, 4) }],
  },
  {
    name: 'Marcus Lee',
    email: 'marcus@northwind.test',
    memberships: [{ tenantId: NORTHWIND, role: 'biller' }],
  },
  {
    name: 'Lena Ortiz',
    email: 'lena@northwind.test',
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
  await seedReference(systemDb);

  for (const payer of PAYERS) {
    await systemDb
      .insert(payers)
      .values({
        id: payer.id,
        name: payer.name,
        aliases: [...payer.aliases],
        stediPayerId: SIM_PAYER_IDS[payer.name] ?? null,
      })
      .onConflictDoUpdate({
        target: payers.id,
        set: {
          name: payer.name,
          aliases: [...payer.aliases],
          stediPayerId: SIM_PAYER_IDS[payer.name] ?? null,
        },
      });
  }

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

  for (const c of CLIENTS) {
    const details = {
      name: c.name,
      status: c.status,
      defaultMode: c.mode,
      billingNpi: npi(c.npiBase),
      address: { line1: '100 Synthetic Way', city: c.city, state: 'OR', zip: '97000' },
      pmBatchTime: c.pmBatchTime ?? null,
      goLiveAt: c.status === 'live' ? new Date('2026-09-15T16:00:00Z') : null,
      // An onboarding client resumes the wizard (O-01 to O-10) where it was left.
      onboarding: c.onboardingStep
        ? {
            step: c.onboardingStep,
            taxIdLast4: last4(c.taxId),
            pm: { adapterKey: c.adapterKey, profile: null, pmName: c.pmName },
          }
        : null,
    };
    await systemDb
      .insert(clients)
      .values({ id: c.id, tenantId: c.tenantId, taxIdEncrypted: encryptField(c.taxId), ...details })
      .onConflictDoUpdate({
        target: clients.id,
        set: {
          ...details,
          taxIdEncrypted: sql`coalesce(${clients.taxIdEncrypted}, excluded.tax_id_encrypted)`,
          // Progress made in the wizard since the last seed is kept.
          onboarding: sql`coalesce(${clients.onboarding}, excluded.onboarding)`,
        },
      });

    const scope = { tenantId: c.tenantId, clientId: c.id };
    for (const pr of c.providers) {
      await systemDb
        .insert(providers)
        .values({ ...scope, npi: npi(pr.npiBase), name: pr.name, taxonomy: pr.taxonomy })
        .onConflictDoNothing();
    }
    for (const loc of c.locations) {
      const [existing] = await systemDb
        .select({ id: locations.id })
        .from(locations)
        .where(and(eq(locations.clientId, c.id), eq(locations.name, loc.name)));
      if (!existing)
        await systemDb.insert(locations).values({ ...scope, name: loc.name, placeOfService: loc.pos });
    }
    for (const [i, payerId] of c.payerIds.entries()) {
      const payer = PAYERS.find((x) => x.id === payerId)!;
      const era =
        c.mode === 'A' ? 'not_required' : c.mode === 'B' ? (i < 4 ? 'active' : 'pending') : 'not_started';
      await systemDb
        .insert(clientPayerSettings)
        .values({
          ...scope,
          payerId,
          timelyFilingDays: payer.filing,
          eraEnrollmentStatus: era,
          pmPayerName: payer.name,
        })
        .onConflictDoNothing();
    }

    // Preview and local connect to the mock PM running the practice's PM profile; real
    // connections are created in onboarding (O-04). Mock connections start in testing, as if the
    // connection test had passed, so the first sync makes them healthy. Others start in setup.
    const connDetails = {
      adapterKey: c.adapterKey,
      levels: PROFILES[c.profile],
      pmAccountRef: c.pmAccountRef ?? null,
      credentialsSecretRef: c.pmMock ? pmMockSecretRef(c) : null,
      // A Tebra-profile mock syncs on Tebra's schedule (docs/05-adapters.md), not the mock default.
      syncIntervalMinutes: c.pmMock && c.profile === 'tebra' ? 120 : null,
      settings: {
        pmName: c.pmName,
        profile: c.profile,
        ...(c.pmMock ? { practiceId: c.pmMock.practiceId } : {}),
      },
    };
    let [conn] = await systemDb
      .select({ id: connections.id, status: connections.status })
      .from(connections)
      .where(eq(connections.clientId, c.id));
    if (!conn) {
      [conn] = await systemDb
        .insert(connections)
        .values({ ...scope, ...connDetails, status: c.pmMock ? 'testing' : 'setup' })
        .returning({ id: connections.id, status: connections.status });
    } else if (c.pmMock) {
      // Older seeds made mock connections without credentials; bring them up to date.
      await systemDb
        .update(connections)
        .set({
          ...connDetails,
          ...(conn.status === 'setup' ? { status: 'testing' } : {}),
        })
        .where(eq(connections.id, conn.id));
    }

    // Onboarding maps the PM's locations to the practice's (O-05); the seed records that mapping.
    if (c.pmMock && conn) {
      for (const [i, loc] of c.locations.entries()) {
        const [row] = await systemDb
          .select({ id: locations.id })
          .from(locations)
          .where(and(eq(locations.clientId, c.id), eq(locations.name, loc.name)));
        if (!row) continue;
        await systemDb
          .insert(externalRefs)
          .values({
            ...scope,
            connectionId: conn.id,
            entityType: 'location',
            entityId: row.id,
            externalId: pmLocationId(c, i + 1),
          })
          .onConflictDoNothing();
      }
    }
  }

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
