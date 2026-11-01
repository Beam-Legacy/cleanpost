import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, KeyRound, Pause, RefreshCw } from 'lucide-react';
import {
  defaultSyncMinutes,
  levelLabel,
  OPERATION_LABEL,
  OPERATIONS,
  summaryLevel,
  type Capability,
} from '@cleanpost/adapters';
import { policy } from '@cleanpost/domain';
import { Banner, EmptyState, ModeBadge, StatusChip, cx } from '@cleanpost/ui';
import { ConnectionChip } from '@/components/connection-status';
import { NoAccess } from '@/components/page';
import { formatDuration, formatWhen } from '@/lib/format';
import { getConnection, listSyncRuns } from '@/lib/queries/integrations';
import { requireActiveContext } from '@/lib/session';

export const metadata: Metadata = { title: 'Connection' };

const UUID_RE = /^[0-9a-f-]{36}$/i;

function LevelChip({ level }: { level: Capability | undefined }) {
  if (level === undefined) return <span className="subtle">—</span>;
  const tone =
    level === 'unavailable'
      ? 'chip-outline'
      : level === 0
        ? 'chip-warn'
        : level === 4
          ? 'chip-good'
          : level === 3
            ? 'chip-ready'
            : 'chip-flight';
  return <span className={cx('chip', tone)}>{levelLabel(level)}</span>;
}

/** I-02 Connection detail. Admins only. No PHI in run details. */
export default async function ConnectionPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireActiveContext();
  if (!policy.authorize(ctx.actor, 'integration.manage').allowed) return <NoAccess />;
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  const c = await getConnection(ctx, id);
  if (!c) notFound();
  const runs = await listSyncRuns(ctx, c.id);
  const interval = c.syncIntervalMinutes ?? defaultSyncMinutes(c.adapterKey);
  const lastByOp = (op: string) => runs.find((r) => r.operation === op);
  const lastOkByOp = (op: string) => runs.find((r) => r.operation === op && r.status === 'succeeded');
  const credentialAgeDays = c.credentialsRotatedAt
    ? (Date.now() - c.credentialsRotatedAt.getTime()) / 86_400_000
    : null;

  return (
    <>
      <Link className="breadcrumb" href="/integrations">
        <ArrowLeft aria-hidden />
        Integrations
      </Link>
      <div className="page-head">
        <div className="stack-sm" style={{ gap: 4 }}>
          <h1>
            {c.clientName} · {c.pmName}
          </h1>
          <div className="row dense muted">
            <ConnectionChip status={c.status} />
            <ModeBadge mode={c.clientMode} long />
            <span>{summaryLevel(c.levels)}</span>·<span>Last success {formatWhen(c.lastSuccessAt)}</span>
            {c.pmAccountRef && (
              <>
                ·<span>Shares a {c.pmName} account with other clients</span>
              </>
            )}
          </div>
        </div>
        <div className="actions" title="Sync controls arrive with the sync worker later in milestone M1">
          <button type="button" className="btn btn-secondary" disabled>
            <Pause aria-hidden />
            Pause syncing
          </button>
          <button type="button" className="btn btn-secondary" disabled>
            <KeyRound aria-hidden />
            Reconnect
          </button>
          <button type="button" className="btn btn-primary" disabled>
            <RefreshCw aria-hidden />
            Run now
          </button>
        </div>
      </div>
      {c.adapterKey === 'mock' && (
        <Banner>
          This preview practice connects to Cleanpost&apos;s mock PM, which behaves like {c.pmName}. No real{' '}
          {c.pmName} account is involved.
        </Banner>
      )}
      {credentialAgeDays !== null && credentialAgeDays > 90 && (
        <Banner tone="warn">The saved login is more than 90 days old. Rotate it with Reconnect.</Banner>
      )}
      <section className="card flush" aria-labelledby="ops-h">
        <div className="card-head">
          <h2 id="ops-h">What this connection does</h2>
        </div>
        <div className="table-wrap">
          <table className="table nowrap">
            <thead>
              <tr>
                <th scope="col">Operation</th>
                <th scope="col">How</th>
                <th scope="col">Health</th>
                <th scope="col">Schedule</th>
                <th scope="col">Last success</th>
              </tr>
            </thead>
            <tbody>
              {OPERATIONS.map((op) => {
                const level = c.levels[op];
                const last = lastByOp(op);
                const isPull = op.startsWith('pull');
                const automatic = typeof level === 'number' && level > 0;
                return (
                  <tr key={op} className={last?.status === 'failed' ? 'row-bad' : undefined}>
                    <td>
                      <b>{OPERATION_LABEL[op]}</b>
                    </td>
                    <td>
                      <LevelChip level={level} />
                    </td>
                    <td>
                      {last ? (
                        <StatusChip
                          status={
                            last.status === 'failed'
                              ? 'Failed'
                              : last.status === 'running'
                                ? 'Running'
                                : 'Healthy'
                          }
                        />
                      ) : (
                        <span className="subtle">
                          {level === 'unavailable' ? '—' : automatic ? 'Not run yet' : 'Manual task'}
                        </span>
                      )}
                    </td>
                    <td>
                      {level === 3
                        ? 'On upload'
                        : isPull && automatic && interval
                          ? `Every ${interval} min`
                          : automatic
                            ? 'On demand'
                            : '—'}
                    </td>
                    <td>{formatWhen(lastOkByOp(op)?.finishedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="table-foot">
          <span>
            Official API · File · Managed API · Browser automation · Manual (Cleanpost prepares a task, a
            biller does it in the PM)
          </span>
        </div>
      </section>
      <section className="card flush" aria-labelledby="runs-h">
        <div className="card-head">
          <h2 id="runs-h">Recent runs</h2>
          <span className="spacer" />
          <span className="subtle">{runs.length ? `${runs.length} most recent` : ''}</span>
        </div>
        {runs.length === 0 ? (
          <EmptyState title="No sync runs yet" tone="neutral">
            Runs appear here once the sync worker pulls from this connection.
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table nowrap">
              <thead>
                <tr>
                  <th scope="col">
                    <span className="sr-only">Result</span>
                  </th>
                  <th scope="col">Operation</th>
                  <th scope="col">Started</th>
                  <th scope="col" className="num">
                    Duration
                  </th>
                  <th scope="col">Records</th>
                  <th scope="col">Error code</th>
                  <th scope="col">
                    <span className="sr-only">Details</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <span
                        className={cx(
                          'dot',
                          r.status === 'failed' ? 'bad' : r.status === 'running' ? 'warn' : 'good',
                        )}
                        role="img"
                        aria-label={r.status}
                      />
                    </td>
                    <td>{OPERATION_LABEL[r.operation as keyof typeof OPERATION_LABEL] ?? r.operation}</td>
                    <td>{formatWhen(r.startedAt)}</td>
                    <td className="num">{formatDuration(r.startedAt, r.finishedAt)}</td>
                    <td>
                      {Object.entries(r.counts)
                        .filter(([, n]) => n)
                        .map(([k, n]) => `${n} ${k}`)
                        .join(' · ') || '0'}
                    </td>
                    <td className="code">{r.errorCode ?? ''}</td>
                    <td>
                      <Link className="btn btn-ghost btn-sm" href={`/integrations/${c.id}/runs/${r.id}`}>
                        Details
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
