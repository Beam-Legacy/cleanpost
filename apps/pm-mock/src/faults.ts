/**
 * Fault injection (docs/05-adapters.md): a request header for one request, or faults stored on the
 * account (set from the admin page or API) so a whole sync run meets them.
 *
 *   X-Mock-Fault: auth_expired | error_500 | partial_page | rate_limited | timeout | latency:<ms>
 */
import { eq } from 'drizzle-orm';
import type { PmDb } from './db';
import { accounts, type AccountFault, type FaultKind } from './schema';

export const FAULT_KINDS: FaultKind[] = [
  'auth_expired',
  'error_500',
  'partial_page',
  'rate_limited',
  'latency',
  'timeout',
];

export interface ActiveFault {
  kind: FaultKind;
  latencyMs?: number;
}

export function parseFaultHeader(value: string | undefined): ActiveFault | null {
  if (!value) return null;
  const [kind, arg] = value.trim().split(':');
  if (kind === 'latency') return { kind: 'latency', latencyMs: Math.min(Number(arg) || 0, 60_000) };
  return FAULT_KINDS.includes(kind as FaultKind) ? { kind: kind as FaultKind } : null;
}

/** Finds the account's first fault that applies to this endpoint, and uses one of its requests. */
export async function takeAccountFault(
  db: PmDb,
  account: { id: string; faults: AccountFault[] },
  endpointName: string,
  now: Date,
): Promise<ActiveFault | null> {
  const live = account.faults.filter((f) => (!f.until || new Date(f.until) > now) && f.remaining !== 0);
  const index = live.findIndex((f) => !f.endpoints || f.endpoints.includes(endpointName));
  const changed = live.length !== account.faults.length;
  if (index < 0) {
    if (changed) await db.update(accounts).set({ faults: live }).where(eq(accounts.id, account.id));
    return null;
  }
  const fault = live[index]!;
  if (fault.remaining !== undefined) {
    live[index] = { ...fault, remaining: fault.remaining - 1 };
  }
  if (changed || fault.remaining !== undefined) {
    await db
      .update(accounts)
      .set({ faults: live.filter((f) => f.remaining !== 0) })
      .where(eq(accounts.id, account.id));
  }
  return { kind: fault.kind, ...(fault.latencyMs ? { latencyMs: fault.latencyMs } : {}) };
}
