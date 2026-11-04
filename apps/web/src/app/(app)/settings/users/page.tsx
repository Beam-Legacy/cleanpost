import type { Metadata } from 'next';
import { CircleAlert, CircleCheck } from 'lucide-react';
import { formatDate, formatWhen } from '@/lib/format';
import { listMembers, type MemberRow } from '@/lib/queries/settings';
import { requireActiveContext } from '@/lib/session';

export const metadata: Metadata = { title: 'Users and roles' };

const ROLE: Record<MemberRow['role'], string> = { admin: 'Admin', biller: 'Biller', viewer: 'Viewer' };

/** What each role can do (docs/11 and packages/domain/src/policy), as S-01 shows it. */
const MATRIX: [string, string, string, string, string][] = [
  ['Work items and claims in their clients', 'All', 'All', 'Work', 'View'],
  ['Release claims and post payments', 'Yes', 'Yes', 'Yes', 'No'],
  ['Clients, integrations, rules, mappings', 'Yes', 'Yes', 'No', 'No'],
  ['Users, security, billing, audit log', 'Yes', 'Yes', 'No', 'No'],
  ['Export patient-level data', 'Yes', 'Yes', 'No', 'No'],
];

function clientsText(m: MemberRow) {
  if (m.clients === 'all') return 'All';
  if (m.clients.length === 0) return '—';
  if (m.clients.length === 1) return m.clients[0];
  return `${m.clients.length} clients`;
}

/** S-01 Users and roles: who can use the workspace, with which role, for which clients. */
export default async function UsersPage() {
  const ctx = await requireActiveContext();
  const members = await listMembers(ctx);
  const active = members.filter((m) => m.status !== 'deactivated').length;
  // Sessions keep real time (DEC-18), so "last active" is measured on the real clock.
  const realNow = new Date();

  return (
    <>
      <div className="row-between">
        <div>
          <h2 className="title-m">Users and roles</h2>
          <p className="muted dense" style={{ margin: 0 }}>
            {active} {active === 1 ? 'user' : 'users'} · two-factor required for everyone
          </p>
        </div>
      </div>
      <div className="card flush">
        <div className="table-wrap">
          <table className="table nowrap" aria-label="Users">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Clients</th>
                <th>Two-factor</th>
                <th>Last active</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.membershipId} className={m.status === 'deactivated' ? 'row-muted' : undefined}>
                  <td>
                    <div className="two-line">
                      <b>
                        {m.name}
                        {m.userId === ctx.user.id ? ' (you)' : ''}
                      </b>
                      <span className="sub">{m.email}</span>
                    </div>
                  </td>
                  <td>{m.isOwner ? 'Owner' : ROLE[m.role]}</td>
                  <td>{clientsText(m)}</td>
                  <td>
                    {m.status === 'deactivated' ? (
                      '—'
                    ) : m.twoFactor ? (
                      <span className="chip chip-good">
                        <CircleCheck aria-hidden />
                        {m.twoFactor === 'passkey' ? 'Passkey' : 'Authenticator'}
                      </span>
                    ) : (
                      <span className="chip chip-warn">
                        <CircleAlert aria-hidden />
                        Not set up
                      </span>
                    )}
                  </td>
                  <td className="muted">
                    {m.status === 'deactivated'
                      ? `Deactivated ${m.deactivatedAt ? formatDate(m.deactivatedAt.toISOString().slice(0, 10)) : ''}`
                      : m.lastActiveAt
                        ? formatWhen(m.lastActiveAt, realNow)
                        : 'Never signed in'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="card flush">
        <div className="card-head">
          <h3>What each role can do</h3>
        </div>
        <div className="table-wrap">
          <table className="table" aria-label="What each role can do">
            <thead>
              <tr>
                <th>
                  <span className="sr-only">Permission</span>
                </th>
                <th>Owner</th>
                <th>Admin</th>
                <th>Biller</th>
                <th>Viewer</th>
              </tr>
            </thead>
            <tbody>
              {MATRIX.map(([what, ...cells]) => (
                <tr key={what}>
                  <th scope="row" style={{ fontWeight: 500 }}>
                    {what}
                  </th>
                  {cells.map((c, i) => (
                    <td key={i}>{c}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
