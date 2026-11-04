'use client';
/** CL-02 to CL-07 tabs. Only the tabs built so far are listed (docs/16). */
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '', label: 'Overview' },
  { href: '/settings', label: 'Settings' },
  { href: '/providers', label: 'Providers and locations' },
  { href: '/payers', label: 'Payers' },
  { href: '/mappings', label: 'Adjustment mappings' },
  { href: '/activity', label: 'Activity' },
] as const;

export function ClientTabs({ clientId }: { clientId: string }) {
  const path = usePathname();
  const base = `/clients/${clientId}`;
  return (
    <nav className="tabs" aria-label="Client sections">
      {TABS.map((t) => {
        const href = `${base}${t.href}`;
        const active = path === href;
        return (
          <Link
            key={t.label}
            href={href}
            className={active ? 'active' : undefined}
            aria-current={active ? 'page' : undefined}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
