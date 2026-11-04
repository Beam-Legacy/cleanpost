import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRightLeft } from 'lucide-react';
import { EmptyState } from '@cleanpost/ui';
import { codeMeaning } from '@/lib/mapping-display';
import { listMappings } from '@/lib/queries/settings';
import { requireActiveContext } from '@/lib/session';
import { AddMapping, MappingRow } from './mapping-row';

export const metadata: Metadata = { title: 'Adjustment mappings' };

/**
 * S-08 Adjustment mappings: how each 835 adjustment code posts in each PM, so verification (Modes A
 * and C) knows what "posted right" means. Company-wide per PM type; clients can override (W-19).
 * Codes waiting for a mapping come first. Denial codes are never mapped.
 */
export default async function MappingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const ctx = await requireActiveContext();
  const { tabs, pmType, rows } = await listMappings(ctx, (await searchParams).pm);
  const tab = tabs.find((t) => t.pmType === pmType);
  const unmapped = rows.filter((r) => r.source === 'unmapped').length;

  return (
    <>
      <div>
        <h2 className="title-m">Adjustment mappings</h2>
        <p className="muted dense" style={{ margin: 0 }}>
          How 835 adjustment codes post in each PM. Changes apply to payments checked after you save.
        </p>
      </div>
      {!tab || !pmType ? (
        <EmptyState title="No PM connected yet" icon={<ArrowRightLeft />}>
          Mappings are per PM. Connect a client&apos;s PM under Integrations first.
        </EmptyState>
      ) : (
        <>
          <nav className="tabs" aria-label="PM systems">
            {tabs.map((t) => (
              <Link
                key={t.pmType}
                href={`/settings/mappings?pm=${encodeURIComponent(t.pmType)}`}
                className={t.pmType === pmType ? 'active' : undefined}
                aria-current={t.pmType === pmType ? 'page' : undefined}
              >
                {t.pmName}
                {t.unmapped > 0 && <span className="chip chip-warn dense">{t.unmapped} unmapped</span>}
              </Link>
            ))}
          </nav>
          <p className="muted dense" style={{ margin: 0 }}>
            {tab.clients === 1 ? '1 client uses' : `${tab.clients} clients use`} {tab.pmName}
            {unmapped > 0 && ` · ${unmapped === 1 ? '1 code waits' : `${unmapped} codes wait`} for a mapping`}
          </p>
          <div className="card flush">
            <div className="table-wrap">
              <table className="table" aria-label={`${tab.pmName} adjustment mappings`}>
                <thead>
                  <tr>
                    <th>835 code</th>
                    <th>Meaning</th>
                    <th>{tab.pmName} code</th>
                    <th>What happens</th>
                    <th>Source</th>
                    <th>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <MappingRow
                      key={`${pmType}-${r.groupCode}-${r.carc}`}
                      pmType={pmType}
                      pmName={tab.pmName}
                      row={{ ...r, meaning: codeMeaning(r.groupCode, r.carc) }}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <div className="card-body" style={{ borderTop: '1px solid var(--border)' }}>
              <AddMapping pmType={pmType} pmName={tab.pmName} />
            </div>
          </div>
          <p className="muted dense" style={{ margin: 0 }}>
            Denial codes (CO and PI, other than contractual ones) are never mapped: the balance stays open for
            the denial queue. A client can have its own mapping for a code, set from the queue.
          </p>
        </>
      )}
    </>
  );
}
