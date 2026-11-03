import 'server-only';
import { now as clockNow } from '@cleanpost/clock';
import { readDemoHistory } from '@cleanpost/db';
import { policy } from '@cleanpost/domain';
import type { ActiveContext } from '@/lib/session';
import { getDb } from '@/lib/server';
import { simConfig, simNow } from '@/lib/sim';
import { SimClock } from './sim-clock';

/** Renders the simulator control for admins where payer-sim exists (local, preview); else nothing. */
export async function SimClockSlot({ ctx }: { ctx: ActiveContext }) {
  const config = simConfig();
  if (!config || !policy.authorize(ctx.actor, 'integration.manage').allowed) return null;
  const [now, history] = await Promise.all([simNow(config), readDemoHistory(getDb()).catch(() => ({}))]);
  return (
    <SimClock
      history={history}
      now={now?.toISOString() ?? null}
      appNow={clockNow().toISOString()}
      realNow={new Date().toISOString()}
    />
  );
}
