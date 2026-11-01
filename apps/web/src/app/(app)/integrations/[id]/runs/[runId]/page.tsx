import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { OPERATION_LABEL } from '@cleanpost/adapters';
import { policy } from '@cleanpost/domain';
import { Card, CardBody, CardHead, KeyValue, StatusChip } from '@cleanpost/ui';
import { NoAccess } from '@/components/page';
import { formatDuration, formatWhen } from '@/lib/format';
import { getConnection, listSyncRuns } from '@/lib/queries/integrations';
import { requireActiveContext } from '@/lib/session';

export const metadata: Metadata = { title: 'Sync run' };

/** I-03 Sync run detail. Only counts and codes, never record contents or identifiers. */
export default async function SyncRunPage({ params }: { params: Promise<{ id: string; runId: string }> }) {
  const ctx = await requireActiveContext();
  if (!policy.authorize(ctx.actor, 'integration.manage').allowed) return <NoAccess />;
  const { id, runId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[0-9a-f-]{36}$/i.test(runId)) notFound();
  const c = await getConnection(ctx, id);
  const run = c ? (await listSyncRuns(ctx, c.id, 500)).find((r) => r.id === runId) : undefined;
  if (!c || !run) notFound();
  const status = run.status === 'failed' ? 'Failed' : run.status === 'running' ? 'Running' : 'Succeeded';
  return (
    <>
      <Link className="breadcrumb" href={`/integrations/${c.id}`}>
        <ArrowLeft aria-hidden />
        {c.clientName} · {c.pmName}
      </Link>
      <div className="page-head">
        <h1>{OPERATION_LABEL[run.operation as keyof typeof OPERATION_LABEL] ?? run.operation}</h1>
        <StatusChip status={status} />
      </div>
      <Card>
        <CardHead title="Run" />
        <CardBody>
          <KeyValue
            items={[
              ['Started', formatWhen(run.startedAt)],
              ['Finished', formatWhen(run.finishedAt)],
              ['Duration', formatDuration(run.startedAt, run.finishedAt)],
              [
                'Run ID',
                <span key="id" className="code">
                  {run.id}
                </span>,
              ],
              ...Object.entries(run.counts).map(([k, n]): [string, string] => [
                k[0]!.toUpperCase() + k.slice(1),
                String(n),
              ]),
              ...(run.errorCode
                ? ([
                    [
                      'Error code',
                      <span key="e" className="code">
                        {run.errorCode}
                      </span>,
                    ],
                  ] as [string, React.ReactNode][])
                : []),
              ...(run.errorDetail ? ([['What happened', run.errorDetail]] as [string, string][]) : []),
            ]}
          />
        </CardBody>
      </Card>
      {run.status === 'failed' && (
        <p className="muted">
          Data that was already pulled is safe. The next scheduled run retries from where this one stopped.
        </p>
      )}
    </>
  );
}
