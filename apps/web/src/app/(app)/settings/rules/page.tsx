import type { Metadata } from 'next';
import Link from 'next/link';
import { CircleAlert } from 'lucide-react';
import { formatWhen } from '@/lib/format';
import { listRules } from '@/lib/queries/rules';
import { listClientChoices } from '@/lib/queries/settings';
import { requireActiveContext } from '@/lib/session';
import { RuleDrawer } from './rule-drawer';

export const metadata: Metadata = { title: 'Rules' };

const SOURCE: Record<string, string> = { seed: 'Built in', user: 'Your company', promoted: 'Promoted' };
const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'seed', label: 'Built in' },
  { key: 'user', label: 'Your company' },
  { key: 'promoted', label: 'Promoted' },
  { key: 'off', label: 'Off' },
] as const;

/**
 * S-05 Rules: every data rule the scrubber applies here, with the last 30 days' hits and how often a
 * person released without applying it (over 20% is worth a look), and the built-in code checks that
 * fired. Rule names open S-06. Proposed rules from corrections (S-07) come next.
 */
export default async function RulesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const ctx = await requireActiveContext();
  const sp = await searchParams;
  const filter = FILTERS.some((f) => f.key === sp.source) ? sp.source! : 'all';
  const q = (sp.q ?? '').trim().toLowerCase().slice(0, 100);
  const [{ rules, checks }, clients] = await Promise.all([listRules(ctx), listClientChoices(ctx)]);
  const now = new Date();
  const count = (k: string) =>
    k === 'all'
      ? rules.length
      : k === 'off'
        ? rules.filter((r) => !r.on).length
        : rules.filter((r) => r.source === k).length;
  const shown = rules.filter(
    (r) =>
      (filter === 'all' || (filter === 'off' ? !r.on : r.source === filter)) &&
      (!q || r.name.toLowerCase().includes(q) || r.when.toLowerCase().includes(q)),
  );
  const href = (k: string) =>
    `/settings/rules?${new URLSearchParams({ ...(k !== 'all' ? { source: k } : {}), ...(q ? { q } : {}) })}`;

  return (
    <>
      <div>
        <h2 className="title-m">Rules</h2>
        <p className="muted dense" style={{ margin: 0 }}>
          {rules.filter((r) => r.on).length} rules on · the checks and fixes the scrubber applies to your
          claims
        </p>
      </div>
      <div className="row-between" style={{ gap: 12 }}>
        <nav className="tabs" aria-label="Rule sources">
          {FILTERS.map((f) => (
            <Link
              key={f.key}
              href={href(f.key)}
              className={f.key === filter ? 'active' : undefined}
              aria-current={f.key === filter ? 'page' : undefined}
            >
              {f.label} <span className="muted">{count(f.key)}</span>
            </Link>
          ))}
        </nav>
        <form method="get" action="/settings/rules" role="search" className="row dense" style={{ gap: 6 }}>
          {filter !== 'all' && <input type="hidden" name="source" value={filter} />}
          <label htmlFor="rules-q" className="sr-only">
            Search rules
          </label>
          <input id="rules-q" className="input" name="q" defaultValue={q} placeholder="Search rules" />
        </form>
      </div>
      <div className="card flush">
        <div className="table-wrap">
          <table className="table" aria-label="Rules">
            <thead>
              <tr>
                <th>Rule</th>
                <th>Scope</th>
                <th>Source</th>
                <th className="num">Hits (30 d)</th>
                <th className="num">Overridden</th>
                <th>On</th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted">
                    No rules match.
                  </td>
                </tr>
              )}
              {shown.map((r) => (
                <tr key={r.id} className={r.on ? undefined : 'row-muted'}>
                  <td>
                    <div className="two-line">
                      <RuleDrawer
                        rule={{
                          ...r,
                          sourceLabel: SOURCE[r.source] ?? r.source,
                          history: r.history.map((h) => ({ ...h, at: formatWhen(h.at, now) })),
                        }}
                        clients={clients}
                      />
                      <span className="sub">
                        {r.kindLabel}
                        {r.history[0] ? ` · ${r.history[0].what.toLowerCase()} by ${r.history[0].who}` : ''}
                      </span>
                    </div>
                  </td>
                  <td>{r.scopeLabel}</td>
                  <td>{SOURCE[r.source] ?? r.source}</td>
                  <td className="num">{r.hits.toLocaleString('en-US')}</td>
                  <td className="num">
                    {r.overridden === null ? (
                      '—'
                    ) : r.overridden > 20 ? (
                      <span className="chip chip-warn">
                        <CircleAlert aria-hidden />
                        {r.overridden}%
                      </span>
                    ) : (
                      `${r.overridden}%`
                    )}
                  </td>
                  <td>
                    {r.on ? 'On' : 'Off'}
                    {r.on && r.offFor.length > 0 && (
                      <span className="muted">
                        {' '}
                        · off for {r.offFor.length === 1 ? '1 client' : `${r.offFor.length} clients`}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="muted dense" style={{ margin: 0 }}>
        Overridden is the share of hits a person released without applying the rule; over 20% suggests the
        rule needs a look.
      </p>
      <div className="card flush">
        <div className="card-head">
          <h3>Built-in code checks</h3>
        </div>
        <p className="muted dense" style={{ margin: '0 16px 12px' }}>
          Always on: they check that a claim can be billed at all (required fields, valid codes and modifiers,
          code pairs, eligibility, duplicates).
        </p>
        <div className="table-wrap">
          <table className="table" aria-label="Built-in code checks">
            <thead>
              <tr>
                <th>Check</th>
                <th className="num">Hits (30 d)</th>
              </tr>
            </thead>
            <tbody>
              {checks.length === 0 ? (
                <tr>
                  <td colSpan={2} className="muted">
                    None fired in the last 30 days.
                  </td>
                </tr>
              ) : (
                checks.map((c) => (
                  <tr key={c.ruleId}>
                    <td className="code">{c.ruleId}</td>
                    <td className="num">{c.hits.toLocaleString('en-US')}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
