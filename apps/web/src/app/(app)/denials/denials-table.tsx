'use client';
/**
 * D-01 list: a row opens D-02. Admins can select denials of one client and write them off together
 * (D-03 bulk, one reason and PM code for all; each denial's denied amount).
 */
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { remit } from '@cleanpost/domain';
import { Button } from '@cleanpost/ui';
import { CodeChip } from '@/components/code-chip';
import { WriteOffDialog } from '@/components/write-off-dialog';
import { formatCount, formatDate, formatMoney, formatWhen } from '@/lib/format';
import type { DenialRow } from '@/lib/queries/denials';
import type { WriteOffOptions } from '@/lib/queries/write-off';

export function DenialsTable({
  rows,
  hrefs,
  total,
  canBulk,
  options,
}: {
  rows: DenialRow[];
  /** D-02 link per item (this page with ?denial=). */
  hrefs: Record<string, string>;
  total: number;
  canBulk: boolean;
  /** Write-off options per client, for the bulk dialog. */
  options: Record<string, WriteOffOptions>;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState(false);
  const chosen = useMemo(() => rows.filter((r) => selected.has(r.itemId)), [rows, selected]);
  const clientIds = new Set(chosen.map((r) => r.clientId));
  const oneClient = clientIds.size === 1 ? [...clientIds][0]! : null;
  const opts = oneClient ? options[oneClient] : undefined;
  const sum = chosen.reduce((s, r) => s + r.writeOffCents, 0);
  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  const allOn = rows.length > 0 && rows.every((r) => selected.has(r.itemId));

  return (
    <div className="card flush">
      {canBulk && chosen.length > 0 && (
        <div
          className="row"
          role="toolbar"
          aria-label="Selected denials"
          style={{
            gap: 8,
            padding: '8px 12px',
            borderBottom: '1px solid var(--border)',
            background: 'var(--surface-sunken)',
          }}
        >
          <span>
            {formatCount(chosen.length)} selected · {formatMoney(sum)}
          </span>
          <span className="spacer" />
          {!oneClient && (
            <span className="muted dense">Choose denials of one client to write off together.</span>
          )}
          <Button variant="danger" size="sm" disabled={!oneClient || sum <= 0} onClick={() => setOpen(true)}>
            Write off
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}
      <div className="table-wrap">
        <table className="table nowrap" aria-label="Open denials">
          <thead>
            <tr>
              {canBulk && (
                <th style={{ width: 32 }}>
                  <input
                    type="checkbox"
                    aria-label="Select all denials"
                    checked={allOn}
                    onChange={(e) =>
                      setSelected(e.target.checked ? new Set(rows.map((r) => r.itemId)) : new Set())
                    }
                  />
                </th>
              )}
              <th>Patient</th>
              <th>DOS</th>
              <th>Client</th>
              <th>Payer</th>
              <th>Category</th>
              <th>Code</th>
              <th className="num">At risk</th>
              <th>Denied</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.itemId} className={selected.has(r.itemId) ? 'selected' : undefined}>
                {canBulk && (
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Select denial for ${r.patient ?? 'claim'}`}
                      checked={selected.has(r.itemId)}
                      onChange={(e) => toggle(r.itemId, e.target.checked)}
                    />
                  </td>
                )}
                <td>
                  <Link href={hrefs[r.itemId] ?? '/denials'} scroll={false}>
                    {r.patient ?? 'Claim'}
                  </Link>
                </td>
                <td>{formatDate(r.dateOfService).replace(/, \d{4}$/, '')}</td>
                <td>{r.clientName ?? '—'}</td>
                <td>
                  <span className="truncate" style={{ maxWidth: 180 }}>
                    {r.payerName ?? '—'}
                  </span>
                </td>
                <td>{remit.DENIAL_KIND_LABEL[r.kind]}</td>
                <td>
                  <CodeChip code={`CO-${r.carc}`} bad />
                </td>
                <td className="num">{formatMoney(r.amountCents)}</td>
                <td>{formatWhen(r.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="table-foot">
        <span>
          Showing {formatCount(rows.length)} of {formatCount(total)}
        </span>
        <span className="spacer" />
        <span>Amounts are the open balance at risk, not billed charges.</span>
      </div>
      {open && opts && (
        <WriteOffDialog
          target={{
            kind: 'bulk',
            items: chosen.map((r) => ({ itemId: r.itemId, amountCents: r.writeOffCents })),
          }}
          pmName={opts.pmName}
          pmCodes={opts.pmCodes}
          limitCents={opts.limitCents}
          canOverLimit
          onClose={() => setOpen(false)}
          onDone={() => setSelected(new Set())}
        />
      )}
    </div>
  );
}
