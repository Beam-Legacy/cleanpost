'use client';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { Bell, CircleHelp, PanelLeft } from 'lucide-react';
import type { policy } from '@cleanpost/domain';
import { IconButton, LogoMark, cx } from '@cleanpost/ui';
import { NAV } from '@/lib/nav';
import { NAV_ICONS } from './icons';
import { ClientSwitcher, type ClientOption } from './client-switcher';
import { CommandPalette } from './command-palette';
import { OfflineBanner } from './offline-banner';
import { SessionTimeout } from './session-timeout';
import { UserMenu } from './user-menu';

export interface AppShellProps {
  user: { name: string; role: policy.Role; isOwner: boolean };
  tenantName: string;
  clients: ClientOption[];
  allowedActions: readonly policy.Action[];
  canSwitchCompany: boolean;
  children: ReactNode;
}

const ROLE_LABEL = { admin: 'Admin', biller: 'Biller', viewer: 'Viewer' } as const;

/** G-01 App shell: sidebar, top bar and content area. */
export function AppShell({
  user,
  tenantName,
  clients,
  allowedActions,
  canSwitchCompany,
  children,
}: AppShellProps) {
  const pathname = usePathname();
  const client = useSearchParams().get('client');
  // G-02: the client filter applies to every page, so navigation carries it along.
  const withClient = (href: string) => (client ? `${href}?client=${encodeURIComponent(client)}` : href);
  const [collapsed, setCollapsed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem('cp-sidebar');
      setCollapsed(saved ? saved === 'collapsed' : window.innerWidth < 1024);
    } catch {
      setCollapsed(window.innerWidth < 1024);
    }
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const typing =
        e.target instanceof HTMLElement &&
        (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(true);
      } else if (!typing && e.key === '/') {
        e.preventDefault();
        setPaletteOpen(true);
      } else if (!typing && e.key === '[') {
        toggle();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  function toggle() {
    setCollapsed((c) => {
      try {
        localStorage.setItem('cp-sidebar', c ? 'expanded' : 'collapsed');
      } catch {
        /* storage unavailable: keep the in-memory state */
      }
      return !c;
    });
  }

  const visible = NAV.filter((n) => allowedActions.includes(n.action));
  const main = visible.filter((n) => !n.admin);
  const admin = visible.filter((n) => n.admin);

  const navLink = (n: (typeof NAV)[number]) => {
    const Icon = NAV_ICONS[n.icon];
    const active = pathname === n.href || pathname.startsWith(`${n.href}/`);
    return (
      <Link
        key={n.href}
        href={withClient(n.href)}
        className={cx('nav-item', active && 'active')}
        aria-current={active ? 'page' : undefined}
        title={collapsed ? n.label : undefined}
      >
        <Icon aria-hidden />
        <span>{n.label}</span>
      </Link>
    );
  };

  return (
    <div className={cx('app', collapsed && 'collapsed')}>
      <a href="#main" className="skip-link btn btn-primary btn-sm">
        Skip to content
      </a>
      <nav className="side" aria-label="Main">
        <div className="side-brand">
          <LogoMark />
          <span>cleanpost</span>
        </div>
        {main.map(navLink)}
        {admin.length > 0 && (
          <>
            <div className="nav-section overline">Admin</div>
            {admin.map(navLink)}
          </>
        )}
        <div className="side-foot">
          {tenantName}
          <br />
          {user.name} · {user.isOwner ? 'Owner' : ROLE_LABEL[user.role]}
        </div>
      </nav>
      <div className="main-col">
        <OfflineBanner />
        <header className="top">
          <IconButton
            label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            ghost
            icon={<PanelLeft aria-hidden />}
            onClick={toggle}
          />
          <ClientSwitcher clients={clients} />
          <button
            type="button"
            className="search"
            onClick={() => setPaletteOpen(true)}
            aria-keyshortcuts="Control+K Meta+K /"
          >
            <span style={{ flex: 1, textAlign: 'left' }}>Search patients, claims, trace numbers</span>
            <span className="kbd" aria-hidden>
              ⌘K
            </span>
          </button>
          <span className="spacer" />
          <IconButton label="Get help" ghost icon={<CircleHelp aria-hidden />} />
          <IconButton label="Notifications" ghost icon={<Bell aria-hidden />} />
          <UserMenu name={user.name} canSwitchCompany={canSwitchCompany} />
        </header>
        <main id="main" className="main" style={{ maxWidth: 1440, width: '100%' }}>
          {children}
        </main>
      </div>
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        nav={visible.map((n) => ({ ...n, href: withClient(n.href) }))}
      />
      <SessionTimeout />
    </div>
  );
}
