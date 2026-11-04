import type { Metadata } from 'next';
import Link from 'next/link';
import { Download, ScrollText } from 'lucide-react';
import { now as clockNow } from '@cleanpost/clock';
import { policy } from '@cleanpost/domain';
import { EmptyState } from '@cleanpost/ui';
import { NoAccess } from '@/components/page';
import {
  actionLabel,
  auditFilters,
  auditQuery as query,
  detailsOf,
  highlighted,
  recordLabel,
} from '@/lib/audit-display';
import { formatWhen } from '@/lib/format';
import { AUDIT_PAGE, listAudit } from '@/lib/queries/settings';
import { requireActiveContext } from '@/lib/session';

export const metadata: Metadata = { title: 'Audit log' };

/** S-13 Audit log: who saw or changed what, filterable and exportable. Read-only, append-only. */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const ctx = await requireActiveContext();
  if (!policy.authorize(ctx.actor, 'audit.view').allowed) return <NoAccess />;
  const f = auditFilters(await searchParams);
  const now = clockNow();
  const { rows, total, actions, records, people } = await listAudit(ctx, f, now);
  const pages = Math.max(1, Math.ceil(total / AUDIT_PAGE));
  const exportQuery = query({ ...f, page: 1 });

  return (
    <>
      <div className="page-head">
        <h1>Audit log</h1>
        <span className="muted">Every view and change of patient data and settings · kept 6 years</span>
        <div className="actions">
          <a
            className="btn btn-secondary btn-sm"
            href={`/audit/export${exportQuery ? `?${exportQuery}` : ''}`}
            download
          >
            <Download aria-hidden />
            Export CSV
          </a>
        </div>
      </div>
      <form className="filters audit-filters" method="get" action="/audit" aria-label="Filter the audit log">
        <span className="row dense" style={{ gap: 6 }}>
          <label className="muted" htmlFor="audit-who">
            User
          </label>
          <select id="audit-who" className="select" name="who" defaultValue={f.who ?? ''}>
            <option value="">Anyone</option>
            <option value="automation">Automation</option>
            {people.map((p) => (
              <option key={p.actor} value={p.actor}>
                {p.name}
              </option>
            ))}
          </select>
        </span>
        <span className="row dense" style={{ gap: 6 }}>
          <label className="muted" htmlFor="audit-action">
            Action
          </label>
          <select id="audit-action" className="select" name="action" defaultValue={f.action ?? ''}>
            <option value="">Any</option>
            {actions.map((a) => (
              <option key={a} value={a}>
                {recordLabel(a.split('.')[0] ?? a)}: {actionLabel(a).toLowerCase()}
              </option>
            ))}
          </select>
        </span>
        <span className="row dense" style={{ gap: 6 }}>
          <label className="muted" htmlFor="audit-record">
            Record
          </label>
          <select id="audit-record" className="select" name="record" defaultValue={f.record ?? ''}>
            <option value="">Any</option>
            {records.map((r) => (
              <option key={r} value={r}>
                {recordLabel(r)}
              </option>
            ))}
          </select>
        </span>
        <span className="row dense" style={{ gap: 6 }}>
          <label className="muted" htmlFor="audit-days">
            When
          </label>
          <select id="audit-days" className="select" name="days" defaultValue={String(f.days)}>
            <option value="1">Last 24 hours</option>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
          </select>
        </span>
        <span className="row dense" style={{ gap: 6 }}>
          <label className="muted" htmlFor="audit-id">
            Record ID
          </label>
          <input
            id="audit-id"
            className="input"
            name="id"
            defaultValue={f.id ?? ''}
            placeholder="Paste a record ID"
            style={{ width: 300 }}
          />
        </span>
        <button type="submit" className="btn btn-secondary btn-sm">
          Filter
        </button>
        {(f.who || f.action || f.record || f.id || f.days !== 7) && (
          <Link className="btn btn-ghost btn-sm" href="/audit">
            Clear
          </Link>
        )}
      </form>
      {rows.length === 0 ? (
        <EmptyState title="No events match" icon={<ScrollText />}>
          Try a longer period or fewer filters.
        </EmptyState>
      ) : (
        <div className="card flush">
          <div className="table-wrap">
            <table className="table nowrap" aria-label="Audit events">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>Action</th>
                  <th>Record</th>
                  <th>Details</th>
                  <th>IP address</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={highlighted(r.action) ? 'row-warn' : undefined}>
                    <td>{formatWhen(r.at, now)}</td>
                    <td>{r.who}</td>
                    <td>{actionLabel(r.action)}</td>
                    <td>
                      {recordLabel(r.entityType)}
                      {r.clientName ? ` · ${r.clientName}` : ''}
                      {r.entityId && (
                        <>
                          {' '}
                          <Link
                            className="code"
                            href={`/audit?${query(f, { id: r.entityId, page: 1 })}`}
                            title="Every event for this record"
                          >
                            {r.entityId.slice(-8)}
                          </Link>
                        </>
                      )}
                    </td>
                    <td className="dense audit-details">{detailsOf(r.metadata)}</td>
                    <td className="muted">{r.ip ?? (r.actor.startsWith('user:') ? '—' : 'System')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="table-foot">
            <span>
              Showing {(f.page - 1) * AUDIT_PAGE + 1}–{(f.page - 1) * AUDIT_PAGE + rows.length} of{' '}
              {total.toLocaleString('en-US')} events
            </span>
            <span className="spacer" />
            {f.page > 1 && (
              <Link className="btn btn-ghost btn-sm" href={`/audit?${query(f, { page: f.page - 1 })}`}>
                Newer
              </Link>
            )}
            {f.page < pages && (
              <Link className="btn btn-ghost btn-sm" href={`/audit?${query(f, { page: f.page + 1 })}`}>
                Older
              </Link>
            )}
          </div>
        </div>
      )}
    </>
  );
}
