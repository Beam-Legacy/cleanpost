import { sql } from 'drizzle-orm';
import { createLogger } from '@cleanpost/log';
import { getDb } from '@/lib/server';

export const dynamic = 'force-dynamic';
const log = createLogger({ name: 'health' });

/** Liveness and database reachability for the platform health check. No data in the response. */
export async function GET() {
  try {
    await getDb().execute(sql`select 1`);
    return Response.json({ ok: true });
  } catch (err) {
    log.error({ err }, 'health check failed');
    return Response.json({ ok: false }, { status: 503 });
  }
}
