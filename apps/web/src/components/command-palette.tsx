'use client';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Dialog } from 'radix-ui';
import { Search } from 'lucide-react';
import type { NavItem } from '@/lib/nav';
import { NAV_ICONS } from './icons';

/**
 * G-03 Global search and command palette (skeleton). M0 offers navigation commands; record search
 * (patients, claims, trace numbers) arrives with those records and is audit-logged.
 */
export function CommandPalette({
  open,
  onOpenChange,
  nav,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  nav: NavItem[];
}) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const commands = useMemo(
    () =>
      nav
        .map((n) => ({ ...n, label: `Go to ${n.label.toLowerCase()}` }))
        .filter((c) => c.label.includes(query.trim().toLowerCase())),
    [nav, query],
  );

  function run(i: number) {
    const c = commands[i];
    if (!c) return;
    onOpenChange(false);
    setQuery('');
    router.push(c.href);
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="cp-scrim" />
        <div className="cp-center" style={{ alignItems: 'flex-start', paddingTop: '12vh' }}>
          <Dialog.Content className="modal" aria-describedby={undefined}>
            <Dialog.Title className="sr-only">Search and commands</Dialog.Title>
            <div className="modal-head" style={{ alignItems: 'center' }}>
              <Search aria-hidden />
              <input
                className="input"
                style={{ border: 0, paddingLeft: 0 }}
                placeholder="Search or type a command"
                aria-label="Search or type a command"
                aria-controls="palette-results"
                aria-activedescendant={commands[index] ? `cmd-${index}` : undefined}
                value={query}
                autoFocus
                onChange={(e) => {
                  setQuery(e.currentTarget.value);
                  setIndex(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') setIndex((i) => Math.min(i + 1, commands.length - 1));
                  if (e.key === 'ArrowUp') setIndex((i) => Math.max(i - 1, 0));
                  if (e.key === 'Enter') run(index);
                }}
              />
            </div>
            <div className="modal-body" style={{ paddingBottom: 12 }}>
              <span className="overline">Commands</span>
              <ul
                id="palette-results"
                role="listbox"
                aria-label="Commands"
                className="menu"
                style={{ listStyle: 'none', margin: 0 }}
              >
                {commands.map((c, i) => {
                  const Icon = NAV_ICONS[c.icon];
                  return (
                    <li
                      key={c.href}
                      id={`cmd-${i}`}
                      role="option"
                      aria-selected={i === index}
                      className={`menu-item${i === index ? ' active' : ''}`}
                      onMouseEnter={() => setIndex(i)}
                      onClick={() => run(i)}
                    >
                      <Icon aria-hidden />
                      {c.label.replace(/^go to (.)/, (_, ch: string) => `Go to ${ch}`)}
                    </li>
                  );
                })}
                {commands.length === 0 && <li className="menu-item">No matching commands</li>}
              </ul>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
