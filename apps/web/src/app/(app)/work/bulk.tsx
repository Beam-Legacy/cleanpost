'use client';
/**
 * W-04 Bulk action bar, W-05 Assign and C-17 Bulk release confirmation. Releasing is never
 * undoable, so it always confirms first and lists what is left out and why.
 */
import { useEffect, useMemo, useState, useTransition } from 'react';
import { Button, ConfirmDialog, Modal, useToast } from '@cleanpost/ui';
import { formatMoney } from '@/lib/format';
import type { Assignee, WorkRow } from '@/lib/queries/work';
import { assign, assigneesFor, bulkRelease } from './actions';

export function BulkBar({
  rows,
  onClear,
  onSnooze,
  canRelease,
  canAssign,
}: {
  rows: WorkRow[];
  onClear: () => void;
  onSnooze: () => void;
  canRelease: boolean;
  canAssign: boolean;
}) {
  const [assignOpen, setAssignOpen] = useState(false);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const releasable = rows.filter((r) => r.releasable);
  return (
    <div
      className="card row"
      role="toolbar"
      aria-label="Selected items"
      style={{
        position: 'sticky',
        bottom: 16,
        padding: '8px 12px',
        marginTop: 8,
        boxShadow: 'var(--shadow-overlay)',
      }}
    >
      <b>{rows.length} selected</b>
      <span className="spacer" />
      {canAssign && <Button onClick={() => setAssignOpen(true)}>Assign</Button>}
      {canAssign && <Button onClick={onSnooze}>Snooze</Button>}
      {canRelease && (
        <span
          title={
            releasable.length
              ? undefined
              : 'Only claim reviews whose findings are all info can be released together'
          }
        >
          <Button variant="primary" disabled={!releasable.length} onClick={() => setReleaseOpen(true)}>
            Release {releasable.length} of {rows.length}
          </Button>
        </span>
      )}
      <Button variant="ghost" onClick={onClear}>
        Clear selection
      </Button>
      <AssignDialog
        open={assignOpen}
        onOpenChange={setAssignOpen}
        itemIds={rows.map((r) => r.id)}
        onDone={onClear}
      />
      <ReleaseDialog open={releaseOpen} onOpenChange={setReleaseOpen} rows={rows} onDone={onClear} />
    </div>
  );
}

/** W-05: type to filter; people without access to every client are not listed. */
export function AssignDialog({
  open,
  onOpenChange,
  itemIds,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  itemIds: string[];
  onDone?: () => void;
}) {
  const [people, setPeople] = useState<Assignee[] | null>(null);
  const [q, setQ] = useState('');
  const [pending, start] = useTransition();
  const toast = useToast();
  useEffect(() => {
    if (!open) return;
    setPeople(null);
    setQ('');
    void assigneesFor(itemIds).then(setPeople);
  }, [open, itemIds]);
  const shown = (people ?? []).filter((p) => p.name.toLowerCase().includes(q.trim().toLowerCase()));
  const pick = (id: string | null) =>
    start(async () => {
      const res = await assign(itemIds, id);
      toast({ message: res.message, ...(res.ok ? {} : { tone: 'bad' as const }) });
      if (res.ok) {
        onOpenChange(false);
        onDone?.();
      }
    });
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={itemIds.length === 1 ? 'Assign item' : `Assign ${itemIds.length} items`}
      size="sm"
    >
      <div className="stack-sm">
        <label className="field">
          <span className="label">Find a person</span>
          <input
            className="input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && shown[0]) pick(shown[0].id);
            }}
          />
        </label>
        {!people && <span className="muted">Loading…</span>}
        <ul className="stack-sm" style={{ listStyle: 'none', padding: 0, margin: 0 }} aria-label="People">
          {shown.map((p) => (
            <li key={p.id}>
              <Button block disabled={pending} onClick={() => pick(p.id)}>
                {p.name}
                <span className="spacer" />
                <span className="muted dense">
                  {p.open} open{p.overdue ? ` · ${p.overdue} overdue` : ''}
                </span>
              </Button>
            </li>
          ))}
        </ul>
        <Button variant="ghost" disabled={pending} onClick={() => pick(null)}>
          Unassign
        </Button>
      </div>
    </Modal>
  );
}

/** C-17: grouped by client and mode with counts and amounts; excluded items listed with the reason. */
function ReleaseDialog({
  open,
  onOpenChange,
  rows,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  rows: WorkRow[];
  onDone: () => void;
}) {
  const toast = useToast();
  const eligible = rows.filter((r) => r.releasable);
  const excluded = rows.length - eligible.length;
  const groups = useMemo(() => {
    const m = new Map<string, { label: string; n: number; cents: number }>();
    for (const r of eligible) {
      const key = `${r.clientName ?? '—'} · Mode ${r.mode ?? '?'}`;
      const g = m.get(key) ?? { label: key, n: 0, cents: 0 };
      g.n++;
      g.cents += r.amountCents ?? 0;
      m.set(key, g);
    }
    return [...m.values()];
  }, [eligible]);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Release ${eligible.length} ${eligible.length === 1 ? 'claim' : 'claims'}`}
      confirmLabel={`Release ${eligible.length} ${eligible.length === 1 ? 'claim' : 'claims'}`}
      description={
        <div className="stack-sm">
          <p>Each claim is approved by you and released to its PM. This cannot be undone.</p>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {groups.map((g) => (
              <li key={g.label}>
                {g.label}: {g.n} · {formatMoney(g.cents)}
              </li>
            ))}
          </ul>
          {excluded > 0 && (
            <p className="muted">
              {excluded} selected {excluded === 1 ? 'item is' : 'items are'} left out: only claim reviews
              whose findings are all info level can be released together.
            </p>
          )}
        </div>
      }
      onConfirm={() => {
        void bulkRelease(eligible.map((r) => r.id)).then((res) => {
          toast({ message: res.message, ...(res.ok ? {} : { tone: 'bad' as const }) });
          if (res.ok) onDone();
        });
      }}
    />
  );
}
