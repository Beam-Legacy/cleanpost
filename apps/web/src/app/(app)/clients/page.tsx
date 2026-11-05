import { now as clockNow } from '@cleanpost/clock';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Plus, Search } from 'lucide-react';
import { policy, reports } from '@cleanpost/domain';
import { EmptyState, ModeBadge, StatusChip } from '@cleanpost/ui';
import { ConnectionDot } from '@/components/connection-status';
import { PageHead } from '@/components/page';
import { listClients } from '@/lib/queries/clients';
import { getOverview, todayPacific } from '@/lib/queries/reports';
import { requireActiveContext } from '@/lib/session';

export const metadata: Metadata = { title: 'Clients' };

const STATUS_CHIP = {
  live: 'Live',
  onboarding: 'Onboarding',
  paused: 'Paused',
  offboarded: 'Closed',
} as const;
const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'live', label: 'Live' },
  { key: 'onboarding', label: 'Onboarding' },
  { key: 'paused', label: 'Paused' },
] as const;

/** CL-01 Clients list. Billers see only clients in their scope and no Add client. */
export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string; client?: string }>;
}) {
  const ctx = await requireActiveContext();
  const { status = 'all', q = '', client } = await searchParams;
  const [all, month] = await Promise.all([
    listClients(ctx),
    getOverview(ctx, reports.periodFor('this_month', todayPacific())),
  ]);
  const kpis = new Map(month.clients.map((m) => [m.client.id, m.kpis]));
  const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v.toFixed(1)}%`);
  const query = q.trim().toLowerCase();
  const rows = all.filter(
    (c) => (status === 'all' || c.status === status) && (!query || c.name.toLowerCase().includes(query)),
  );
  const counts = Object.fromEntries(
    FILTERS.map((f) => [f.key, f.key === 'all' ? all.length : all.filter((c) => c.status === f.key).length]),
  );
  const canAdd = policy.authorize(ctx.actor, 'client.create').allowed;
  const keep = (extra: Record<string, string>) => {
    const p = new URLSearchParams({ ...(client ? { client } : {}), ...(q ? { q } : {}), ...extra });
    return `/clients?${p}`;
  };
  const now = clockNow();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  return (
    <>
      <PageHead
        title="Clients"
        subtitle={`${all.length} clients · ${counts.live} live · ${counts.onboarding} onboarding`}
        actions={
          canAdd ? (
            <Link className="btn btn-primary" href="/clients/new/practice">
              <Plus aria-hidden />
              Add client
            </Link>
          ) : undefined
        }
      />
      <div className="filters">
        <form action="/clients" className="search" style={{ maxWidth: 320 }} role="search">
          <Search aria-hidden />
          <input name="q" defaultValue={q} placeholder="Find client" aria-label="Find client" />
          {status !== 'all' && <input type="hidden" name="status" value={status} />}
          {client && <input type="hidden" name="client" value={client} />}
        </form>
        {FILTERS.map((f) => (
          <Link
            key={f.key}
            href={keep(f.key === 'all' ? {} : { status: f.key })}
            className={`filter-chip${status === f.key ? ' on' : ''}`}
            aria-current={status === f.key ? 'true' : undefined}
          >
            {f.label} <span className="n">{counts[f.key]}</span>
          </Link>
        ))}
      </div>
      {rows.length === 0 ? (
        <EmptyState
          title={all.length ? 'No clients match' : 'Add your first client'}
          tone="neutral"
          action={
            !all.length && canAdd ? (
              <Link className="btn btn-primary" href="/clients/new/practice">
                <Plus aria-hidden />
                Add client
              </Link>
            ) : undefined
          }
        >
          {all.length
            ? 'Try a different name or status.'
            : 'The wizard takes a new practice from nothing to live.'}
        </EmptyState>
      ) : (
        <section className="card flush" aria-label="Clients">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Client</th>
                  <th scope="col">PM system</th>
                  <th scope="col">Mode</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="num">
                    Claims this month
                  </th>
                  <th scope="col" className="num">
                    First-pass accepted
                  </th>
                  <th scope="col" className="num">
                    Released without review
                  </th>
                  <th scope="col" className="num">
                    Open items
                  </th>
                  <th scope="col">Connection</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link href={`/clients/${c.id}`}>
                        <b>{c.name}</b>
                      </Link>
                    </td>
                    <td>{c.pmName}</td>
                    <td>
                      <ModeBadge mode={c.mode} long />
                    </td>
                    <td>
                      <StatusChip status={STATUS_CHIP[c.status]} />
                    </td>
                    <td className="num">{c.status === 'onboarding' ? '—' : (kpis.get(c.id)?.claims ?? 0)}</td>
                    <td className="num">{pct(kpis.get(c.id)?.firstPass)}</td>
                    <td className="num">{pct(kpis.get(c.id)?.releasedWithoutReview)}</td>
                    <td className="num">{c.status === 'onboarding' ? '—' : c.openItems}</td>
                    <td>
                      {c.status === 'onboarding' && c.onboardingStep ? (
                        canAdd ? (
                          <Link className="subtle" href={`/clients/${c.id}`}>
                            Step {c.onboardingStep} of 10
                          </Link>
                        ) : (
                          <span className="subtle">Step {c.onboardingStep} of 10</span>
                        )
                      ) : c.connectionId && canAdd ? (
                        <Link href={`/integrations/${c.connectionId}`}>
                          <ConnectionDot status={c.connectionStatus} />
                        </Link>
                      ) : (
                        <ConnectionDot status={c.connectionStatus} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="table-foot">
            <span>
              Month to date, {fmt(monthStart)} to {fmt(now)}. Claim figures start with claims (milestone M2).
            </span>
          </div>
        </section>
      )}
    </>
  );
}
