import type { Metadata } from 'next';
import Link from 'next/link';
import { ListChecks } from 'lucide-react';
import { z } from 'zod';
import { OPERATION_LABEL } from '@cleanpost/adapters';
import { EmptyState } from '@cleanpost/ui';
import { PageHead } from '@/components/page';
import { formatCount, formatWhen } from '@/lib/format';
import { listManualTasks } from '@/lib/queries/tasks';
import { requireActiveContext } from '@/lib/session';

export const metadata: Metadata = { title: 'Manual tasks' };

const Id = z.uuid();
const STATUS: Record<string, string> = { open: 'Open', escalated: 'Escalated', failed: 'Failed' };

/** M-03 Manual tasks: open work to finish in a PM by hand, and which integrations would save most. */
export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const ctx = await requireActiveContext();
  const sp = await searchParams;
  const data = await listManualTasks(ctx, { clientId: Id.safeParse(sp.client).success ? sp.client! : null });
  const minutes = data.last30.reduce((s, r) => s + r.minutes, 0);
  const label = (op: string) => OPERATION_LABEL[op as keyof typeof OPERATION_LABEL] ?? op;

  return (
    <>
      <PageHead
        title="Manual tasks"
        subtitle={`${formatCount(data.rows.length)} open · about ${formatCount(Math.round(minutes / 60))} hours of hand work in the last 30 days (estimate)`}
      />
      {data.last30.length > 0 && (
        <div className="card card-body stack-sm">
          <h2>Where the hand work comes from (last 30 days)</h2>
          <table className="table" aria-label="Manual work by operation and PM">
            <thead>
              <tr>
                <th>Operation</th>
                <th>PM</th>
                <th className="num">Tasks</th>
                <th className="num">Minutes (estimate)</th>
              </tr>
            </thead>
            <tbody>
              {data.last30.map((r) => (
                <tr key={`${r.operation}|${r.pmName}`}>
                  <td>{label(r.operation)}</td>
                  <td>{r.pmName}</td>
                  <td className="num">{formatCount(r.count)}</td>
                  <td className="num">{formatCount(r.minutes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted dense">
            An integration that does the operation removes these tasks.{' '}
            <Link href="/integrations">See integrations</Link>
          </p>
        </div>
      )}
      {data.rows.length === 0 ? (
        <EmptyState title="No open manual tasks" tone="good" icon={<ListChecks />}>
          Every operation for your clients is running through integrations right now.
        </EmptyState>
      ) : (
        <div className="card flush">
          <div className="table-wrap">
            <table className="table nowrap" aria-label="Open manual tasks">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Client</th>
                  <th>Operation</th>
                  <th>Status</th>
                  <th>Assignee</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((t) => (
                  <tr key={t.id}>
                    <td>
                      {t.workItemId ? <Link href={`/work?item=${t.workItemId}`}>{t.title}</Link> : t.title}
                    </td>
                    <td>{t.clientName}</td>
                    <td>
                      {label(t.operation)} <span className="muted">in {t.pmName}</span>
                    </td>
                    <td>{STATUS[t.status] ?? t.status}</td>
                    <td className={t.assignee ? undefined : 'muted'}>{t.assignee ?? 'Unassigned'}</td>
                    <td>{formatWhen(t.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
