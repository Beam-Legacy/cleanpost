/**
 * `pnpm demo:reset` (DEC-19): start the demo world over 90 days back; the worker then replays the
 * 90 days (30 to 45 minutes) and the Demo clock bar shows how far it has got. Local and preview only.
 *
 *   --if-new   only when no history was built, or an older replay version built it (the preview's
 *              release step uses this; DEMO_HISTORY_VERSION)
 *   --force    even while a replay is running (it stops at its next step)
 */
import { z } from 'zod';
import { parseEnv } from '@cleanpost/config';
import { readDemoHistory } from '@cleanpost/db';
import { createSystemDatabase } from '@cleanpost/db/system';
import { createLogger } from '@cleanpost/log';
import {
  DEMO_HISTORY_DAYS,
  DEMO_HISTORY_VERSION,
  demoHistoryAllowed,
  demoStartOffset,
  wipeForDemoHistory,
} from './demo';

const log = createLogger({ name: 'demo-reset' });
const env = parseEnv(
  z.object({
    CLEANPOST_ENV: z.enum(['local', 'preview', 'staging', 'production']).default('local'),
    DATABASE_ADMIN_URL: z.string().min(1),
    PAYER_SIM_URL: z.url().optional(),
    PAYER_SIM_TOKEN: z.string().optional(),
    PM_MOCK_URL: z.url().optional(),
    PM_MOCK_ADMIN_PASSWORD: z.string().optional(),
  }),
);
const args = new Set(process.argv.slice(2));

if (!demoHistoryAllowed(env.CLEANPOST_ENV)) {
  log.error('demo history is only available in local and preview');
  process.exit(1);
}
if (!env.PAYER_SIM_URL || !env.PM_MOCK_URL || !env.PM_MOCK_ADMIN_PASSWORD) {
  const message = 'demo history needs PAYER_SIM_URL, PM_MOCK_URL and PM_MOCK_ADMIN_PASSWORD';
  if (args.has('--if-new')) {
    log.info(`${message}; skipped`);
    process.exit(0);
  }
  log.error(message);
  process.exit(1);
}

const handle = createSystemDatabase(env.DATABASE_ADMIN_URL);
try {
  const current = await readDemoHistory(handle.db);
  // A history an older replay built (or is building) is started over: the deploy that brought the
  // new replay also replaces the worker running the old one.
  const outdated = Boolean(current.state) && (current.version ?? 1) < DEMO_HISTORY_VERSION;
  if (args.has('--if-new') && current.state && !outdated) {
    log.info({ state: current.state }, 'demo history already built; skipped');
  } else if (current.state === 'running' && !args.has('--force') && !(args.has('--if-new') && outdated)) {
    log.error({ day: current.day }, 'a replay is running; wait for it, or pass --force');
    process.exitCode = 1;
  } else {
    const offsetMs = demoStartOffset(DEMO_HISTORY_DAYS);
    const sim = await fetch(`${env.PAYER_SIM_URL.replace(/\/$/, '')}/admin/reset`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(env.PAYER_SIM_TOKEN ? { authorization: `Bearer ${env.PAYER_SIM_TOKEN}` } : {}),
      },
      body: JSON.stringify({ offsetMs }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!sim.ok) throw new Error(`payer-sim refused the reset: ${sim.status}`);
    const pm = await fetch(`${env.PM_MOCK_URL.replace(/\/$/, '')}/admin/api/demo/reset`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`admin:${env.PM_MOCK_ADMIN_PASSWORD}`).toString('base64')}`,
      },
      signal: AbortSignal.timeout(300_000),
    });
    if (!pm.ok) throw new Error(`pm-mock refused the reset: ${pm.status}`);
    await wipeForDemoHistory(handle.db, { days: DEMO_HISTORY_DAYS, offsetMs });
    log.info({ days: DEMO_HISTORY_DAYS }, 'demo reset; the worker replays the history next');
    process.stdout.write(
      `Demo world reset to ${DEMO_HISTORY_DAYS} days ago. The worker replays the days next (30 to 45 minutes); the Demo clock on Work shows progress.\n`,
    );
  }
} catch (err) {
  if (args.has('--if-new')) {
    // A release step: the simulators may not be up yet. The next deploy tries again.
    log.warn({ err }, 'demo history not started; the next deploy tries again');
  } else {
    log.error({ err }, 'demo reset failed');
    process.exitCode = 1;
  }
} finally {
  await handle.close();
}
