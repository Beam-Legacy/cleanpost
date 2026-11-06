'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Dialog } from 'radix-ui';
import {
  ArrowRight,
  Bell,
  Building2,
  ChartColumn,
  FileText,
  Landmark,
  Plus,
  Search,
  Upload,
  User,
  UserPlus,
} from 'lucide-react';
import { search } from '@cleanpost/domain';
import type { RecentRecord, SearchResults } from '@cleanpost/search';
import { ModeBadge, StatusChip } from '@cleanpost/ui';
import { recentAction, searchAction } from '@/app/(app)/search-actions';
import { CLAIM_STATUS } from '@/lib/claim-display';
import type { PaletteCommand } from '@/lib/commands';
import { formatDate, formatMoney } from '@/lib/format';

const COMMAND_ICONS: Record<PaletteCommand['icon'], typeof Search> = {
  'arrow-right': ArrowRight,
  upload: Upload,
  plus: Plus,
  'user-plus': UserPlus,
  bell: Bell,
  user: User,
  'chart-column': ChartColumn,
};
const RECENT_ICONS = { patient: User, claim: FileText, remittance: Landmark } as const;
const RECENT_HREF = { patient: '/patients/', claim: '/claims/', remittance: '/remittances/' } as const;
const CLIENT_STATUS: Record<string, string> = { onboarding: 'Onboarding', paused: 'Paused' };

/** "Oct 22" for a date (YYYY-MM-DD). */
function shortDay(ymd: string | null) {
  if (!ymd) return '—';
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

const methodLabel = (m: string) => (m === 'CHK' ? 'check' : m === 'NON' ? 'no payment' : 'EFT');

interface Item {
  key: string;
  href: string;
  node: ReactNode;
}
interface Group {
  id: string;
  label: string;
  items: Item[];
  loading?: boolean;
}

/** Which record groups this person's role can see, so loading rows show only those. */
export interface PaletteScope {
  patients: boolean;
  claims: boolean;
  remittances: boolean;
  clients: boolean;
}

/**
 * G-03 Global search and command palette. Searches patients (name, date of birth), claims (control
 * or payer claim number), remittances (trace number) and clients, within the person's clients and
 * role; each search is audit-logged by hash, never its text. Commands start with ">" or match by
 * name. Nothing typed here is kept once it closes.
 */
export function CommandPalette({
  open,
  onOpenChange,
  commands,
  scope,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  commands: PaletteCommand[];
  scope: PaletteScope;
}) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ q: string; r: SearchResults | null } | null>(null);
  const [recents, setRecents] = useState<RecentRecord[] | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const seq = useRef(0);
  const parsed = search.parseQuery(query);
  const searchable = parsed.kind === 'dob' || parsed.kind === 'number' || parsed.kind === 'name';
  const loading = searchable && found?.q !== parsed.text;

  // Recent records each time it opens; everything typed goes when it closes.
  useEffect(() => {
    if (!open) {
      setQuery('');
      setFound(null);
      setRecents(null);
      setActiveKey(null);
      return;
    }
    let live = true;
    recentAction()
      .then((r) => live && setRecents(r))
      .catch(() => live && setRecents([]));
    return () => {
      live = false;
    };
  }, [open]);

  useEffect(() => {
    if (!open || !searchable) return;
    const text = parsed.text;
    const mine = ++seq.current;
    const t = setTimeout(() => {
      searchAction(text)
        .then((r) => mine === seq.current && setFound({ q: text, r }))
        .catch(() => mine === seq.current && setFound({ q: text, r: null }));
    }, 150);
    return () => clearTimeout(t);
  }, [open, searchable, parsed.text]);

  const groups = useMemo<Group[]>(() => {
    const cmd = (c: PaletteCommand): Item => {
      const Icon = COMMAND_ICONS[c.icon];
      return {
        key: `cmd:${c.id}`,
        href: c.href,
        node: (
          <>
            <Icon aria-hidden />
            {c.label}
            {c.hint && <span className="meta">{c.hint}</span>}
          </>
        ),
      };
    };
    if (parsed.kind === 'command') {
      return [
        { id: 'commands', label: 'Commands', items: search.matchCommands(commands, parsed.text).map(cmd) },
      ];
    }
    if (parsed.kind === 'empty') {
      const recent: Item[] = (recents ?? []).map((r) => {
        const Icon = RECENT_ICONS[r.type];
        return {
          key: `recent:${r.id}`,
          href: `${RECENT_HREF[r.type]}${r.id}`,
          node: (
            <>
              <Icon aria-hidden />
              {r.type === 'patient' ? <b>{r.label}</b> : <span className="code">{r.label}</span>}
              <span className="meta">{r.detail}</span>
            </>
          ),
        };
      });
      return [
        { id: 'recent', label: 'Recent', items: recent, loading: recents === null },
        {
          id: 'commands',
          label: 'Commands',
          items: search.matchCommands(commands, parsed.text).slice(0, 5).map(cmd),
        },
      ];
    }
    const r = loading ? null : found?.r;
    const out: Group[] = [];
    if (scope.patients) {
      out.push({
        id: 'patients',
        label: 'Patients',
        loading,
        items: (r?.patients ?? []).map((p) => ({
          key: `patient:${p.id}`,
          href: `/patients/${p.id}`,
          node: (
            <>
              <User aria-hidden />
              <span>
                <b>{p.name}</b> · {p.age} y{p.dob && <> · born {formatDate(p.dob)}</>}
              </span>
              <span className="meta">{p.client}</span>
            </>
          ),
        })),
      });
    }
    if (scope.claims) {
      out.push({
        id: 'claims',
        label: 'Claims',
        loading,
        items: (r?.claims ?? []).map((c) => ({
          key: `claim:${c.id}`,
          href: `/claims/${c.id}`,
          node: (
            <>
              <FileText aria-hidden />
              <span className="code">{c.pcn ?? '—'}</span>
              <span>
                {c.patient} · {shortDay(c.dateOfService)}
                {c.payer && <> · {c.payer}</>}
              </span>
              <span className="meta">
                <StatusChip status={CLAIM_STATUS[c.status] ?? 'Draft'} />
              </span>
            </>
          ),
        })),
      });
    }
    if (scope.remittances) {
      out.push({
        id: 'remittances',
        label: 'Remittances',
        loading,
        items: (r?.remittances ?? []).map((x) => ({
          key: `remittance:${x.id}`,
          href: `/remittances/${x.id}`,
          node: (
            <>
              <Landmark aria-hidden />
              <span>
                {x.payer} {methodLabel(x.method)} <span className="code">{x.trace}</span>
                {x.patient && <> · includes {x.patient}</>}
              </span>
              <span className="meta">
                {formatMoney(x.amountCents)} · {shortDay(x.paymentDate)}
              </span>
            </>
          ),
        })),
      });
    }
    if (scope.clients) {
      out.push({
        id: 'clients',
        label: 'Clients',
        loading,
        items: (r?.clients ?? []).map((c) => ({
          key: `client:${c.id}`,
          href: `/clients/${c.id}`,
          node: (
            <>
              <Building2 aria-hidden />
              <span>{c.name}</span>
              <span className="meta">
                {c.pmName ?? 'No PM'} · <ModeBadge mode={c.mode as 'A' | 'B' | 'C'} />
                {CLIENT_STATUS[c.status] && <> · {CLIENT_STATUS[c.status]}</>}
              </span>
            </>
          ),
        })),
      });
    }
    out.push({
      id: 'commands',
      label: 'Commands',
      items: search.matchCommands(commands, parsed.text).slice(0, 5).map(cmd),
    });
    return out;
  }, [parsed.kind, parsed.text, commands, recents, found, loading, scope]);

  const shown = groups.filter((g) => g.items.length > 0 || g.loading);
  const items = shown.flatMap((g) => g.items);
  const active = items.find((i) => i.key === activeKey) ?? items[0];
  const failed = searchable && !loading && found?.r === null;
  const nothing = searchable && !loading && !failed && items.length === 0;
  const optionId = (key: string) => `cp-${key.replace(/[^a-z0-9-]/gi, '-')}`;

  useEffect(() => {
    if (active) document.getElementById(optionId(active.key))?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  function go(item: Item | undefined) {
    if (!item) return;
    onOpenChange(false);
    router.push(item.href);
  }

  function move(by: number) {
    if (!items.length || !active) return;
    const i = items.indexOf(active);
    setActiveKey(items[(i + by + items.length) % items.length]!.key);
  }

  /** Tab and Shift+Tab: first row of the next or previous group with rows. */
  function jumpGroup(by: number) {
    const withRows = shown.filter((g) => g.items.length);
    if (!withRows.length || !active) return;
    const at = withRows.findIndex((g) => g.items.includes(active));
    setActiveKey(withRows[(at + by + withRows.length) % withRows.length]!.items[0]!.key);
  }

  const count = items.length;
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="cp-scrim" />
        <div className="cp-center" style={{ alignItems: 'flex-start', paddingTop: '10vh' }}>
          <Dialog.Content className="modal lg" aria-describedby={undefined}>
            <Dialog.Title className="sr-only">Search and commands</Dialog.Title>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
              <div className="row" style={{ flexWrap: 'nowrap', gap: 10 }}>
                <Search aria-hidden />
                <input
                  type="search"
                  className="input"
                  style={{ border: 0, height: 32, padding: 0, fontSize: 16 }}
                  placeholder="Search patients, claims, trace numbers, or type > for commands"
                  aria-label="Search or type a command"
                  role="combobox"
                  aria-expanded
                  aria-autocomplete="list"
                  aria-controls="palette-results"
                  aria-activedescendant={active ? optionId(active.key) : undefined}
                  autoComplete="off"
                  spellCheck={false}
                  value={query}
                  autoFocus
                  onChange={(e) => {
                    setQuery(e.currentTarget.value);
                    setActiveKey(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      move(1);
                    } else if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      move(-1);
                    } else if (e.key === 'Tab') {
                      e.preventDefault();
                      jumpGroup(e.shiftKey ? -1 : 1);
                    } else if (e.key === 'Enter') {
                      e.preventDefault();
                      go(active);
                    }
                  }}
                />
                <span className="kbd" aria-hidden>
                  Esc
                </span>
              </div>
            </div>
            <div
              id="palette-results"
              role="listbox"
              aria-label="Results"
              className="stack-sm"
              style={{ padding: 8, maxHeight: 520, overflow: 'auto' }}
            >
              {shown.map((g) => (
                <div key={g.id} role="group" aria-label={g.label}>
                  <div className="overline" style={{ padding: '6px 10px' }} aria-hidden>
                    {g.label}
                  </div>
                  {g.loading && !g.items.length
                    ? [60, 40].map((w) => (
                        <div key={w} className="menu-item" aria-hidden style={{ cursor: 'default' }}>
                          <span className="skeleton" style={{ width: `${w}%` }} />
                        </div>
                      ))
                    : g.items.map((item) => (
                        <div
                          key={item.key}
                          id={optionId(item.key)}
                          role="option"
                          aria-selected={item === active}
                          className={`menu-item${item === active ? ' active' : ''}`}
                          onMouseMove={() => item !== active && setActiveKey(item.key)}
                          onClick={() => go(item)}
                        >
                          {item.node}
                        </div>
                      ))}
                </div>
              ))}
              {nothing && (
                <div style={{ padding: '16px 10px' }}>
                  <p>
                    <b>Nothing matches “{parsed.text}”.</b>
                  </p>
                  <p className="muted dense">
                    Try a patient control number, payer claim number or trace number, a last name, or a date
                    of birth like 3/7/1984.
                  </p>
                </div>
              )}
              {failed && (
                <p className="muted dense" style={{ padding: '16px 10px' }}>
                  Search isn&apos;t working right now. Try again in a moment.
                </p>
              )}
              {parsed.kind === 'command' && !count && (
                <p className="muted dense" style={{ padding: '16px 10px' }}>
                  No commands match “{parsed.text}”.
                </p>
              )}
            </div>
            <div className="sr-only" aria-live="polite">
              {loading ? '' : count === 1 ? '1 result' : `${count} results`}
            </div>
            <div className="table-foot" style={{ borderTop: '1px solid var(--border)' }}>
              <span>
                <span className="kbd">↑</span> <span className="kbd">↓</span> move
              </span>
              <span>
                <span className="kbd">Enter</span> open
              </span>
              <span>
                <span className="kbd">Tab</span> next group
              </span>
              <span>
                <span className="kbd">&gt;</span> commands only
              </span>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
