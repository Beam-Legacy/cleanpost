import {
  createDevSecretResolver,
  createRegistry,
  memoryFileSource,
  type AdapterRegistry,
} from '@cleanpost/adapters';
import { clients, connections, createDatabase, users } from '@cleanpost/db';
import { testDatabaseUrls } from '@cleanpost/db/testing';
import { createLogger } from '@cleanpost/log';
import { createPmDb, createPmMockApp } from '@cleanpost/pm-mock';
import { seedPmMock } from '@cleanpost/pm-mock/seed';
import { seed } from '@cleanpost/seed';
import { CLIENTS, NORTHWIND } from '@cleanpost/seed/world';
import { createPgRateLimiter, runSync } from '@cleanpost/sync';
import { eq } from 'drizzle-orm';

export { NORTHWIND };
export const SECRET = 'pm-mock-claims-test-secret-01';
const urls = testDatabaseUrls();
export const admin = createDatabase(urls.adminUrl, { max: 2 });
export const app = createDatabase(urls.url, { max: 6 });
export const pm = createPmDb(urls.adminUrl, 3);
export const log = createLogger({ name: 'claims-test' });
export const pmApp = createPmMockApp({ db: pm.db, log, rateScale: 1000 });

export const client = (name: string) => CLIENTS.find((c) => c.name.startsWith(name))!;

const pmFetch = ((input: string | URL | Request, init?: RequestInit) =>
  Promise.resolve(pmApp.request(String(input), init))) as typeof fetch;

export const registry: AdapterRegistry = createRegistry({
  fileSource: memoryFileSource({}),
  mock: {
    baseUrl: 'http://pm-mock.test',
    secrets: createDevSecretResolver({ pmMockSecret: SECRET }),
    limiter: createPgRateLimiter(app.db),
    fetch: pmFetch,
  },
});

export async function connectionOf(name: string) {
  const [row] = await admin.db
    .select()
    .from(connections)
    .where(eq(connections.clientId, client(name).id));
  return row!;
}

export async function clientRow(name: string) {
  const [row] = await admin.db
    .select()
    .from(clients)
    .where(eq(clients.id, client(name).id));
  return row!;
}

/** A seeded user's ID (better-auth assigns them at seed time). */
export async function userIdOf(email = 'dana@northwind.test') {
  const [u] = await admin.db.select({ id: users.id }).from(users).where(eq(users.email, email));
  return u!.id;
}

let world: Promise<void> | undefined;

/** The synthetic world, synced from the mock PM into Cleanpost once per test file. */
export function syncedWorld(scale = 1) {
  world ??= (async () => {
    await seed(admin.db, 'claims-test-password-123');
    await seedPmMock(pm.db, { secret: SECRET, asOf: new Date(), scale });
    for (const name of ['Lakeside', 'Willamette', 'Cascade']) {
      const conn = await connectionOf(name);
      const res = await runSync(
        { db: app.db, registry, log, retryDelaysMs: [10] },
        { tenantId: NORTHWIND, connectionId: conn.id, trigger: 'manual' },
      );
      if (res.status !== 'done' || res.connectionStatus !== 'healthy')
        throw new Error(`sync failed for ${name}`);
    }
  })();
  return world;
}

export async function closeAll() {
  await Promise.all([admin.close(), app.close(), pm.close()]);
}
