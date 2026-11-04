import type { Metadata } from 'next';
import { automationSettings } from '@/lib/queries/settings';
import { requireActiveContext } from '@/lib/session';
import { ClientThreshold } from './client-threshold';
import { DefaultThreshold } from './default-threshold';

export const metadata: Metadata = { title: 'Automation' };

/** reports.rate is already a percentage (0 to 100). */
const pct = (v: number | null) => (v === null ? '—' : `${v.toFixed(v === 100 ? 0 : 1)}%`);

/**
 * S-04 Automation: how much goes out without a person reviewing it, company-wide and per client,
 * with last month's evidence (DEC-23). Client-payer overrides stay on the client's payer settings.
 */
export default async function AutomationPage() {
  const ctx = await requireActiveContext();
  const a = await automationSettings(ctx);
  return (
    <>
      <div>
        <h2 className="title-m">Automation</h2>
        <p className="muted dense" style={{ margin: 0 }}>
          When claims go out without a person reviewing them
        </p>
      </div>
      <DefaultThreshold current={a.company} scores={a.scores} scrubbed={a.scrubbed} />
      <div className="card flush">
        <div className="card-head">
          <h3>Client overrides</h3>
        </div>
        <div className="table-wrap">
          <table className="table" aria-label="Client release thresholds">
            <thead>
              <tr>
                <th>Client</th>
                <th style={{ width: 380 }}>Threshold</th>
                <th className="num">Released without review (30 days)</th>
                <th className="num">First-pass when auto-released</th>
              </tr>
            </thead>
            <tbody>
              {a.clients.map((c) => (
                <tr key={c.id}>
                  <th scope="row" style={{ fontWeight: 500 }}>
                    {c.name}
                  </th>
                  <td>
                    <ClientThreshold
                      clientId={c.id}
                      clientName={c.name}
                      threshold={c.threshold}
                      company={a.company}
                    />
                  </td>
                  <td className="num">{pct(c.releasedWithoutReview)}</td>
                  <td className="num">{pct(c.autoFirstPass)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="muted dense" style={{ margin: 0 }}>
        A blocking finding always sends a claim to review, whatever the threshold. Changes apply to claims
        scrubbed after you save. A payer can have its own threshold for one client, set on the client.
      </p>
    </>
  );
}
