'use client';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Building2, ChevronDown } from 'lucide-react';
import { Popover } from '@cleanpost/ui';

export interface ClientOption {
  id: string;
  name: string;
  status: string;
}

/** G-02 Client switcher: filters every screen to one client (?client=) or all clients in scope. */
export function ClientSwitcher({ clients }: { clients: ClientOption[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const current = clients.find((c) => c.id === params.get('client'));
  const matches = useMemo(
    () => clients.filter((c) => c.name.toLowerCase().includes(query.trim().toLowerCase())),
    [clients, query],
  );

  if (clients.length === 1) {
    return (
      <span className="switcher" aria-label="Client">
        <Building2 aria-hidden />
        {clients[0]!.name}
      </span>
    );
  }

  function select(id: string | null) {
    const next = new URLSearchParams(params);
    if (id) next.set('client', id);
    else next.delete('client');
    try {
      localStorage.setItem('cp-client', id ?? '');
    } catch {
      /* ignore */
    }
    setOpen(false);
    setQuery('');
    router.push(`${pathname}${next.size ? `?${next}` : ''}`);
  }

  return (
    <Popover
      label="Choose client"
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button type="button" className="switcher" aria-haspopup="dialog">
          <Building2 aria-hidden />
          {current?.name ?? 'All clients'}
          <ChevronDown aria-hidden />
        </button>
      }
    >
      <input
        className="input"
        aria-label="Filter clients"
        placeholder="Find client"
        value={query}
        autoFocus
        onChange={(e) => setQuery(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && matches[0]) select(matches[0].id);
        }}
      />
      <div className="menu" style={{ padding: 0 }} role="listbox" aria-label="Clients">
        <button
          type="button"
          role="option"
          aria-selected={!current}
          className="menu-item"
          style={{ width: '100%', border: 0, background: 'none', font: 'inherit' }}
          onClick={() => select(null)}
        >
          All clients
          <span className="meta">{clients.length}</span>
        </button>
        {matches.map((c) => (
          <button
            key={c.id}
            type="button"
            role="option"
            aria-selected={current?.id === c.id}
            className="menu-item"
            style={{ width: '100%', border: 0, background: 'none', font: 'inherit', textAlign: 'left' }}
            onClick={() => select(c.id)}
          >
            {c.name}
            {c.status !== 'live' && (
              <span className="meta">{c.status === 'paused' ? 'Paused' : 'Onboarding'}</span>
            )}
          </button>
        ))}
      </div>
    </Popover>
  );
}
