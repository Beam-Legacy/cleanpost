import Link from 'next/link';
import type { ReactNode } from 'react';
import { PeriodPicker } from '@/components/reports/period-picker';

export type ReportTab = 'overview' | 'client' | 'aging' | 'denials' | 'team';

/** The reports header: title, scope line, period, export, and the report tabs (RP-01 layout). */
export function ReportHead({
  title,
  scope,
  tab,
  preset,
  showTeam,
  firstClientId,
  actions,
  query,
}: {
  title: string;
  scope: string;
  tab: ReportTab;
  /** Omitted where the report is "as of today" (A/R aging). */
  preset?: string;
  showTeam: boolean;
  firstClientId: string | null;
  actions?: ReactNode;
  /** Carried between tabs (the period). */
  query: string;
}) {
  const q = query ? `?${query}` : '';
  const tabs: { key: ReportTab; label: string; href: string | null }[] = [
    { key: 'overview', label: 'Overview', href: `/reports${q}` },
    {
      key: 'client',
      label: 'Client report',
      href: firstClientId ? `/reports/clients/${firstClientId}${q}` : null,
    },
    { key: 'aging', label: 'A/R aging', href: '/reports/aging' },
    { key: 'denials', label: 'Denials', href: `/reports/denials${q}` },
    ...(showTeam ? [{ key: 'team' as const, label: 'Team', href: `/reports/team${q}` }] : []),
  ];
  return (
    <>
      <div className="page-head">
        <h1>{title}</h1>
        <span className="muted">{scope}</span>
        <div className="actions">
          {preset && <PeriodPicker value={preset} />}
          {actions}
        </div>
      </div>
      <nav className="tabs" aria-label="Reports">
        {tabs.map((t) =>
          t.href ? (
            <Link
              key={t.key}
              href={t.href}
              className={t.key === tab ? 'active' : undefined}
              aria-current={t.key === tab ? 'page' : undefined}
            >
              {t.label}
            </Link>
          ) : null,
        )}
      </nav>
    </>
  );
}
