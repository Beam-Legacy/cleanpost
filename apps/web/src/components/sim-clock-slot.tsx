import 'server-only';
import { policy } from '@cleanpost/domain';
import type { ActiveContext } from '@/lib/session';
import { simConfig, simNow } from '@/lib/sim';
import { SimClock } from './sim-clock';

/** Renders the simulator control for admins where payer-sim exists (local, preview); else nothing. */
export async function SimClockSlot({ ctx }: { ctx: ActiveContext }) {
  const config = simConfig();
  if (!config || !policy.authorize(ctx.actor, 'integration.manage').allowed) return null;
  const now = await simNow(config);
  return <SimClock now={now?.toISOString() ?? null} realNow={new Date().toISOString()} />;
}
