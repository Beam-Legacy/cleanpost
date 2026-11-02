'use client';
/**
 * W-01 Work queue: the list, the side panel (W-10 to W-24), the W-06 snooze and W-07 resolve
 * dialogs, and the keyboard (docs/08 "Speed requirements"): J/K move, Enter opens the claim,
 * A approves, E edits, S snoozes, R resolves, Esc closes the panel, ? lists the keys.
 */
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { work } from '@cleanpost/domain';
import { Button, DueChip, Kbd, Modal, PriorityMarker, useToast } from '@cleanpost/ui';
import { formatMoney } from '@/lib/format';
import type { WorkDetail, WorkRow } from '@/lib/queries/work';
import {
  applyFixes,
  approveAndRelease,
  resolve,
  snooze,
  snoozeMany,
  undo,
  type WorkActionResult,
} from './actions';
import { AssignDialog, BulkBar } from './bulk';
import { WorkPanel, primaryAction } from './work-panel';

export interface Permissions {
  release: boolean;
  edit: boolean;
  resolve: boolean;
  admin: boolean;
}

function isTyping(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  // Checkboxes and radios take a click, not text: shortcuts still work with focus on them.
  if (tag === 'INPUT')
    return !['checkbox', 'radio', 'button', 'submit', 'reset'].includes((el as HTMLInputElement).type);
  return tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export function WorkQueue({
  rows,
  selectedId,
  detail,
  can,
  now,
  total,
}: {
  rows: WorkRow[];
  selectedId: string | null;
  detail: WorkDetail | null;
  can: Permissions;
  now: string;
  total: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [resolveOpen, setResolveOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  // W-04 selection (checkboxes), kept to rows still in the list.
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const checkedRows = rows.filter((r) => checked.has(r.id));
  const [bulkSnoozeOpen, setBulkSnoozeOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const toggle = (id: string) =>
    setChecked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const nowDate = useMemo(() => new Date(now), [now]);
  const selectedRow = useRef<HTMLTableRowElement | null>(null);
  // Set once the keyboard handler is attached (tests wait for it before timing a review).
  const [keysReady, setKeysReady] = useState(false);

  const hrefFor = useCallback(
    (id: string | null) => {
      const next = new URLSearchParams(params);
      if (id) next.set('item', id);
      else next.delete('item');
      return `${pathname}${next.size ? `?${next}` : ''}`;
    },
    [params, pathname],
  );
  const select = useCallback(
    (id: string | null) => router.replace(hrefFor(id), { scroll: false }),
    [router, hrefFor],
  );
  const index = rows.findIndex((r) => r.id === selectedId);
  // Where J/K move from: updated at once on each press, so fast presses move several rows
  // before the page has re-rendered for the first one.
  const cursor = useRef(index);
  useEffect(() => {
    cursor.current = index;
  }, [index]);
  const neighbour = useCallback(() => {
    if (index < 0) return null;
    return rows[index + 1]?.id ?? rows[index - 1]?.id ?? null;
  }, [rows, index]);

  useEffect(() => {
    selectedRow.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  const run = useCallback(
    (action: () => Promise<WorkActionResult>) => {
      const nextId = neighbour();
      start(async () => {
        const res = await action();
        const u = res.undo;
        toast({
          message: res.message,
          ...(res.ok ? {} : { tone: 'bad' as const }),
          ...(u
            ? {
                onUndo: () => {
                  void undo(u).then((r) => {
                    toast({ message: r.message, ...(r.ok ? {} : { tone: 'bad' as const }) });
                    if (r.ok && u.kind !== 'approve') router.replace(hrefFor(u.itemId), { scroll: false });
                    if (r.ok && u.kind === 'approve' && selectedId)
                      router.replace(hrefFor(selectedId), { scroll: false });
                  });
                },
              }
            : {}),
        });
        // Resolving an item moves to the next one (W-01 rules).
        if (res.ok && res.done) select(nextId);
      });
    },
    [neighbour, start, toast, select, router, hrefFor, selectedId],
  );

  const primary = detail ? primaryAction(detail, can) : null;
  const doPrimary = useCallback(() => {
    if (!detail?.claim?.versionId || !primary) return;
    const base = { itemId: detail.item.id, claimId: detail.claim.id, versionId: detail.claim.versionId };
    run(() => approveAndRelease({ ...base, ruleIds: primary.ruleIds }));
  }, [detail, primary, run]);
  const doFix = useCallback(
    (ruleId: string) => {
      if (!detail?.claim?.versionId) return;
      const claim = detail.claim;
      start(async () => {
        const res = await applyFixes({
          itemId: detail.item.id,
          claimId: claim.id,
          versionId: claim.versionId!,
          ruleIds: [ruleId],
        });
        toast({ message: res.message, ...(res.ok ? {} : { tone: 'bad' as const }) });
      });
    },
    [detail, start, toast],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (snoozeOpen || resolveOpen || keysOpen) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      const key = e.key;
      if (key === 'j' || key === 'ArrowDown') {
        e.preventDefault();
        const at = cursor.current;
        const next = rows[at + 1] ?? (at < 0 ? rows[0] : undefined);
        if (next) {
          cursor.current = rows.indexOf(next);
          select(next.id);
        }
      } else if (key === 'k' || key === 'ArrowUp') {
        e.preventDefault();
        const at = cursor.current;
        const prev = at > 0 ? rows[at - 1] : undefined;
        if (prev) {
          cursor.current = at - 1;
          select(prev.id);
        }
      } else if (key === 'Escape' && checked.size) {
        setChecked(new Set());
      } else if (key === 'Escape' && selectedId) {
        select(null);
      } else if (key === 'Enter' && detail?.claim) {
        router.push(`/claims/${detail.claim.id}`);
      } else if ((key === 'a' || key === 'A') && primary && !pending) {
        e.preventDefault();
        doPrimary();
      } else if ((key === 'e' || key === 'E') && detail?.claim && can.edit) {
        router.push(`/claims/${detail.claim.id}?edit=1`);
      } else if ((key === 's' || key === 'S') && detail && can.resolve) {
        e.preventDefault();
        setSnoozeOpen(true);
      } else if ((key === 'r' || key === 'R') && detail && can.resolve) {
        e.preventDefault();
        setResolveOpen(true);
      } else if (key === '?') {
        setKeysOpen(true);
      }
    }
    document.addEventListener('keydown', onKey);
    setKeysReady(true);
    return () => document.removeEventListener('keydown', onKey);
  }, [
    rows,
    index,
    select,
    selectedId,
    detail,
    primary,
    pending,
    doPrimary,
    can,
    router,
    snoozeOpen,
    resolveOpen,
    keysOpen,
    checked.size,
  ]);

  const open = Boolean(detail);
  return (
    <div className="split" data-keys={keysReady ? 'on' : 'off'}>
      <div className="split-main card flush">
        <div className="table-wrap">
          <table className="table nowrap" aria-label="Work items">
            <thead>
              {open ? (
                <tr>
                  <th className="w-check">
                    <input
                      type="checkbox"
                      aria-label="Select all"
                      checked={rows.length > 0 && checkedRows.length === rows.length}
                      onChange={(e) =>
                        setChecked(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())
                      }
                    />
                  </th>
                  <th>
                    <span className="sr-only">Priority</span>
                  </th>
                  <th>Item</th>
                  <th>Patient and client</th>
                  <th className="num">Amount</th>
                  <th>Due</th>
                </tr>
              ) : (
                <tr>
                  <th className="w-check">
                    <input
                      type="checkbox"
                      aria-label="Select all"
                      checked={rows.length > 0 && checkedRows.length === rows.length}
                      onChange={(e) =>
                        setChecked(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())
                      }
                    />
                  </th>
                  <th>
                    <span className="sr-only">Priority</span>
                  </th>
                  <th>Type</th>
                  <th>Client</th>
                  <th>Patient</th>
                  <th>Payer</th>
                  <th className="num">Amount</th>
                  <th>Reason</th>
                  <th>Assignee</th>
                  <th>Due</th>
                </tr>
              )}
            </thead>
            <tbody>
              {rows.map((r) => {
                const label = work.WORK_TYPE_LABEL[r.type as work.WorkItemType] ?? r.type;
                const state = work.dueState(new Date(r.dueAt), nowDate);
                const due = (
                  <DueChip {...(state === 'ok' ? {} : { state })}>
                    {r.status === 'snoozed' && r.snoozedUntil
                      ? `Snoozed · ${work.dueLabel(new Date(r.dueAt), nowDate)}`
                      : work.dueLabel(new Date(r.dueAt), nowDate)}
                  </DueChip>
                );
                const selected = r.id === selectedId;
                const mode = r.mode ? <span className="mode">{r.mode}</span> : null;
                return (
                  <tr
                    key={r.id}
                    ref={selected ? selectedRow : undefined}
                    className={selected ? 'selected' : undefined}
                    aria-selected={selected}
                    onClick={() => select(r.id)}
                    style={{ cursor: 'pointer' }}
                  >
                    <td onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`Select ${label}${r.patient ? ` for ${r.patient}` : ''}`}
                        checked={checked.has(r.id)}
                        onChange={() => toggle(r.id)}
                      />
                    </td>
                    <td>
                      <PriorityMarker priority={r.priority} />
                    </td>
                    {open ? (
                      <>
                        <td>
                          <div className="two-line">
                            <Link
                              href={hrefFor(r.id)}
                              scroll={false}
                              replace
                              onClick={(e) => e.stopPropagation()}
                            >
                              <b>{label}</b>
                            </Link>
                            <span className="sub truncate" style={{ maxWidth: 200 }} title={r.summary}>
                              {r.summary}
                            </span>
                          </div>
                        </td>
                        <td>
                          <div className="two-line">
                            <span className="truncate" style={{ maxWidth: 200 }}>
                              {[r.patient, r.payerName].filter(Boolean).join(' · ') || '—'}
                            </span>
                            <span className="sub">
                              {r.clientName ?? '—'} {mode}
                            </span>
                          </div>
                        </td>
                      </>
                    ) : (
                      <>
                        <td>
                          <Link
                            href={hrefFor(r.id)}
                            scroll={false}
                            replace
                            onClick={(e) => e.stopPropagation()}
                          >
                            <b>{label}</b>
                          </Link>
                        </td>
                        <td>
                          {r.clientName ?? '—'} {mode}
                        </td>
                        <td>{r.patient ?? '—'}</td>
                        <td>
                          <span className="truncate" style={{ maxWidth: 160 }}>
                            {r.payerName ?? '—'}
                          </span>
                        </td>
                      </>
                    )}
                    <td className="num">{formatMoney(r.amountCents)}</td>
                    {!open && (
                      <>
                        <td>
                          <span className="truncate" style={{ maxWidth: 260 }} title={r.summary}>
                            {r.summary}
                          </span>
                        </td>
                        <td className={r.assigneeName ? undefined : 'muted'}>
                          {r.assigneeName ?? 'Unassigned'}
                        </td>
                      </>
                    )}
                    <td>{due}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="table-foot">
          <span>
            <Kbd>J</Kbd> <Kbd>K</Kbd> next, previous
          </span>
          <span>
            <Kbd>A</Kbd> approve
          </span>
          <span>
            <Kbd>E</Kbd> edit
          </span>
          <span>
            <Kbd>S</Kbd> snooze
          </span>
          <span>
            <Kbd>R</Kbd> resolve
          </span>
          <span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setKeysOpen(true)}>
              <Kbd>?</Kbd> all shortcuts
            </button>
          </span>
          <span className="spacer" />
          <span>
            Showing {rows.length} of {total}
          </span>
        </div>
        {checkedRows.length > 0 && (
          <BulkBar
            rows={checkedRows}
            onClear={() => setChecked(new Set())}
            onSnooze={() => setBulkSnoozeOpen(true)}
            canRelease={can.release}
            canAssign={can.resolve}
          />
        )}
        <SnoozeDialog
          open={bulkSnoozeOpen}
          onOpenChange={setBulkSnoozeOpen}
          now={nowDate}
          overdue={checkedRows.some((r) => work.dueState(new Date(r.dueAt), nowDate) === 'over')}
          onPick={(until) => {
            setBulkSnoozeOpen(false);
            const ids = checkedRows.map((r) => r.id);
            start(async () => {
              const res = await snoozeMany(ids, until.toISOString());
              toast({ message: res.message, ...(res.ok ? {} : { tone: 'bad' as const }) });
              setChecked(new Set());
            });
          }}
        />
      </div>
      {detail && <AssignDialog open={assignOpen} onOpenChange={setAssignOpen} itemIds={[detail.item.id]} />}
      {detail && (
        <WorkPanel
          detail={detail}
          can={can}
          pending={pending}
          primary={primary}
          onPrimary={doPrimary}
          onFix={doFix}
          onSnooze={() => setSnoozeOpen(true)}
          onResolve={() => setResolveOpen(true)}
          onAssign={() => setAssignOpen(true)}
          onClose={() => select(null)}
        />
      )}
      {detail && (
        <SnoozeDialog
          open={snoozeOpen}
          onOpenChange={setSnoozeOpen}
          now={nowDate}
          overdue={work.dueState(new Date(detail.item.dueAt), nowDate) === 'over'}
          onPick={(until) => {
            setSnoozeOpen(false);
            run(() => snooze(detail.item.id, until.toISOString()));
          }}
        />
      )}
      {detail && (
        <ResolveDialog
          open={resolveOpen}
          onOpenChange={setResolveOpen}
          type={detail.item.type}
          onResolve={(reason, note) => {
            setResolveOpen(false);
            run(() => resolve(detail.item.id, reason, note));
          }}
        />
      )}
      <Modal open={keysOpen} onOpenChange={setKeysOpen} title="Keyboard shortcuts" size="sm">
        <table className="table">
          <tbody>
            {[
              ['J or ↓', 'Next item'],
              ['K or ↑', 'Previous item'],
              ['Enter', 'Open the full claim'],
              ['A', 'Approve and release (fixes first, where suggested)'],
              ['E', 'Edit the claim'],
              ['S', 'Snooze'],
              ['R', 'Resolve with a reason'],
              ['Esc', 'Close the panel'],
              ['?', 'This list'],
            ].map(([k, v]) => (
              <tr key={k}>
                <td>
                  <Kbd>{k}</Kbd>
                </td>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Modal>
    </div>
  );
}

const fmtWhen = (d: Date) =>
  d
    .toLocaleString('en-US', {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'America/Los_Angeles',
    })
    .replace(' AM', ' am')
    .replace(' PM', ' pm');

/** W-06 Snooze: presets, or a date and time. Snoozing never moves the SLA. */
function SnoozeDialog({
  open,
  onOpenChange,
  now,
  overdue,
  onPick,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  now: Date;
  overdue: boolean;
  onPick: (until: Date) => void;
}) {
  const presets = useMemo(() => work.snoozePresets(now), [now]);
  const [custom, setCustom] = useState('');
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Snooze until"
      size="sm"
      description={
        overdue ? 'This item is past its SLA; snoozing does not stop the overdue alert.' : undefined
      }
    >
      <div className="stack-sm">
        {presets.map((p) => (
          <Button key={p.key} block onClick={() => onPick(p.until)}>
            {p.label}
            <span className="spacer" />
            <span className="muted">{fmtWhen(p.until)}</span>
          </Button>
        ))}
        <label className="field">
          <span className="label">Pick date and time (Pacific)</span>
          <input
            className="input"
            type="datetime-local"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
          />
        </label>
        <Button
          variant="primary"
          disabled={!custom}
          onClick={() => {
            // datetime-local is the browser's local time; the Date constructor reads it as such.
            const until = new Date(custom);
            if (!Number.isNaN(until.getTime())) onPick(until);
          }}
        >
          Snooze
        </Button>
      </div>
    </Modal>
  );
}

/** W-07 Resolve with reason: a reason is required; "Other" needs a note. */
function ResolveDialog({
  open,
  onOpenChange,
  type,
  onResolve,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  type: string;
  onResolve: (reason: string, note: string | null) => void;
}) {
  const reasons = work.reasonsFor(type);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  useEffect(() => {
    if (open) {
      setReason('');
      setNote('');
    }
  }, [open]);
  const needsNote = reason === 'Other';
  const ready = Boolean(reason) && (!needsNote || note.trim().length > 0);
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Resolve item"
      size="sm"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!ready} onClick={() => onResolve(reason, note.trim() || null)}>
            Resolve
          </Button>
        </>
      }
    >
      <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="label">Reason</legend>
        {reasons.map((r) => (
          <label key={r} className="check">
            <input
              type="radio"
              name="reason"
              value={r}
              checked={reason === r}
              onChange={() => setReason(r)}
            />
            {r}
          </label>
        ))}
      </fieldset>
      <label className="field" style={{ marginTop: 12 }}>
        <span className="label">Note{needsNote ? ' (required for Other)' : ' (optional)'}</span>
        <textarea
          className="textarea"
          rows={3}
          value={note}
          maxLength={1000}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
    </Modal>
  );
}
