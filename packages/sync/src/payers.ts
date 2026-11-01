/**
 * Matches the payer name a PM uses to a payer row: the client's own mapping first
 * (client_payer_settings.pm_payer_name, O-06), then payer names and aliases. Unmatched names stay on
 * the coverage as text until someone maps them.
 */
import { eq } from 'drizzle-orm';
import { clientPayerSettings, payers, type Tx } from '@cleanpost/db';

export interface PayerMatcher {
  match(pmName: string): string | null;
}

const norm = (s: string) => s.trim().toLowerCase();

export async function loadPayerMatcher(tx: Tx, clientId: string): Promise<PayerMatcher> {
  const mapped = await tx
    .select({ payerId: clientPayerSettings.payerId, pmName: clientPayerSettings.pmPayerName })
    .from(clientPayerSettings)
    .where(eq(clientPayerSettings.clientId, clientId));
  const all = await tx.select({ id: payers.id, name: payers.name, aliases: payers.aliases }).from(payers);
  const byName = new Map<string, string>();
  for (const p of all) {
    for (const n of [p.name, ...p.aliases]) if (!byName.has(norm(n))) byName.set(norm(n), p.id);
  }
  for (const m of mapped) if (m.pmName) byName.set(norm(m.pmName), m.payerId);
  return { match: (pmName) => byName.get(norm(pmName)) ?? null };
}
