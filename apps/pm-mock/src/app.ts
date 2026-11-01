import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Logger } from '@cleanpost/log';
import { adminRoutes } from './admin';
import { apiRoutes } from './api';
import type { PmDb } from './db';
import { RateLimiter } from './rate-limit';

export interface PmMockOptions {
  db: PmDb;
  log: Logger;
  /** Basic-auth password for /admin; the admin page is off without one. */
  adminPassword?: string;
  /** Multiplies every rate limit (tests). Default 1. */
  rateScale?: number;
  now?: () => Date;
}

export function createPmMockApp(opts: PmMockOptions) {
  const now = opts.now ?? (() => new Date());
  const app = new Hono();
  app.use('*', async (c, next) => {
    const started = Date.now();
    await next();
    // Route pattern only: paths carry record IDs and query strings carry cursors.
    opts.log.debug(
      { method: c.req.method, route: c.req.routePath, status: c.res.status, ms: Date.now() - started },
      'request',
    );
  });
  app.get('/health', (c) => c.json({ ok: true }));
  app.route(
    '/api/v1',
    apiRoutes({ db: opts.db, limiter: new RateLimiter(), rateScale: opts.rateScale ?? 1, now }),
  );
  if (opts.adminPassword)
    app.route('/admin', adminRoutes({ db: opts.db, password: opts.adminPassword, now }));
  app.get('/', (c) => c.redirect(opts.adminPassword ? '/admin' : '/health'));
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    opts.log.error({ err }, 'unhandled error');
    return c.json({ error: 'server_error', message: 'Internal error' }, 500);
  });
  return app;
}
