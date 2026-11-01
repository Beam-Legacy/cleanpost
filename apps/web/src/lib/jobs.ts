import 'server-only';
import { parseEnv, dbEnvSchema } from '@cleanpost/config';
import { createBoss, type PgBoss } from '@cleanpost/jobs';
import { createLogger } from '@cleanpost/log';

const log = createLogger({ name: 'web-jobs' });
let boss: Promise<PgBoss> | undefined;

/** The web app's job queue client: sends only (no schedule, no maintenance), as the app role. */
export function getBoss(): Promise<PgBoss> {
  boss ??= (async () => {
    const b = createBoss(parseEnv(dbEnvSchema).DATABASE_URL, 'web');
    b.on('error', (err) => log.error({ err }, 'job queue error'));
    await b.start();
    return b;
  })().catch((err: unknown) => {
    boss = undefined;
    throw err;
  });
  return boss;
}
