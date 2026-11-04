import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Building2 } from 'lucide-react';
import { policy } from '@cleanpost/domain';
import { EmptyState } from '@cleanpost/ui';
import { clientPayers } from '@/lib/queries/client-detail';
import { requireActiveContext } from '@/lib/session';
import { TimelyFiling } from './timely-filing';

export const metadata: Metadata = { title: 'Client payers' };

const ENROLLMENT: Record<string, string> = {
  not_required: 'Not required',
  not_started: 'Not started',
  pending: 'Pending',
  active: 'Active',
  rejected: 'Rejected',
};

/**
 * CL-05 Payers: each payer the client bills, its Stedi payer ID and name in the PM, last 90 days'
 * claims, timely filing limit (editable) and enrollment. Mode overrides and ERA enrollment come with
 * Modes B and C (CL-09, CL-10).
 */
export default async function ClientPayersPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireActiveContext();
  if (!policy.authorize(ctx.actor, 'client.view', { clientId: id }).allowed) notFound();
  const rows = await clientPayers(ctx, id);
  const canEdit = policy.authorize(ctx.actor, 'client.manage', { clientId: id }).allowed;
  if (!rows.length)
    return (
      <EmptyState title="No payers set up yet" icon={<Building2 />}>
        Payers are matched during onboarding (O-06) and as the PM sends new ones.
      </EmptyState>
    );
  return (
    <>
      <div className="card flush">
        <div className="table-wrap">
          <table className="table" aria-label="Payers">
            <thead>
              <tr>
                <th>Payer</th>
                <th>Name in the PM</th>
                <th>Stedi payer ID</th>
                <th className="num">Claims (90 days)</th>
                <th>Timely filing</th>
                <th>Claims enrollment</th>
                <th>ERA enrollment</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <th scope="row" style={{ fontWeight: 500 }}>
                    {r.payerName}
                  </th>
                  <td>{r.pmPayerName ?? '—'}</td>
                  <td className="code">{r.stediPayerId ?? '—'}</td>
                  <td className="num">{r.claims90}</td>
                  <td>
                    <TimelyFiling
                      clientId={id}
                      settingsId={r.id}
                      payerName={r.payerName}
                      days={r.timelyFilingDays}
                      canEdit={canEdit}
                    />
                  </td>
                  <td>{ENROLLMENT[r.ediEnrollment] ?? r.ediEnrollment}</td>
                  <td>{ENROLLMENT[r.eraEnrollment] ?? r.eraEnrollment}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="muted dense" style={{ margin: 0 }}>
        Timely filing counts from the date of service; follow-ups and corrected-claim deadlines use it. In
        Mode A the PM sends claims, so enrollment matters once the client moves to Mode B or C.
      </p>
    </>
  );
}
