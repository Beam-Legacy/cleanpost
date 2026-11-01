import { createDevSecretResolver, createRegistry, memoryFileSource } from '@cleanpost/adapters';
import { connections, createDatabase } from '@cleanpost/db';
import { testDatabaseUrls } from '@cleanpost/db/testing';
import { createLogger } from '@cleanpost/log';
import { createPmDb, createPmMockApp } from '@cleanpost/pm-mock';
import { seedPmMock } from '@cleanpost/pm-mock/seed';
import { seed } from '@cleanpost/seed';
import { CLIENTS } from '@cleanpost/seed/world';
import { eq } from 'drizzle-orm';
import { createPgRateLimiter, type SyncDeps } from '../src';

export const SECRET = 'pm-mock-sync-test-secret-0123';
const urls = testDatabaseUrls();
export const admin = createDatabase(urls.adminUrl, { max: 2 });
export const app = createDatabase(urls.url, { max: 6 });
export const pm = createPmDb(urls.adminUrl, 3);
export const log = createLogger({ name: 'sync-test' });

export const client = (name: string) => CLIENTS.find((c) => c.name.startsWith(name))!;

/** fetch over an in-process pm-mock, honouring abort signals like a real fetch. */
export function appFetch(target: {
  request: (input: string, init?: RequestInit) => Response | Promise<Response>;
}) {
  return ((input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener('abort', () => reject(signal.reason));
      Promise.resolve(target.request(String(input), init)).then(resolve, reject);
    })) as typeof fetch;
}

export function deps(opts: { rateScale?: number } = {}): SyncDeps {
  const pmApp = createPmMockApp({ db: pm.db, log, rateScale: opts.rateScale ?? 1000 });
  return {
    db: app.db,
    log,
    retryDelaysMs: [20, 20],
    registry: createRegistry({
      fileSource: memoryFileSource({}),
      mock: {
        baseUrl: 'http://pm-mock.test',
        secrets: createDevSecretResolver({ pmMockSecret: SECRET }),
        limiter: createPgRateLimiter(app.db),
        fetch: appFetch(pmApp),
      },
    }),
  };
}

let seeded: Promise<void> | undefined;
export function seedWorld() {
  seeded ??= (async () => {
    await seed(admin.db, 'sync-test-password-123');
    await seedPmMock(pm.db, { secret: SECRET, asOf: new Date(), scale: 0.15 });
  })();
  return seeded;
}

export async function connectionOf(name: string) {
  const [row] = await admin.db
    .select()
    .from(connections)
    .where(eq(connections.clientId, client(name).id));
  return row!;
}

export async function closeAll() {
  await Promise.all([admin.close(), app.close(), pm.close()]);
}
