import type { policy } from '@cleanpost/domain';

/** Sidebar navigation, from ui/assets/shell.js (the real list). Admin items need the matching right. */
export interface NavItem {
  href: string;
  label: string;
  icon:
    | 'inbox'
    | 'file-text'
    | 'landmark'
    | 'circle-x'
    | 'list-checks'
    | 'building-2'
    | 'chart-column'
    | 'plug-zap'
    | 'settings'
    | 'scroll-text';
  admin?: boolean;
  action: policy.Action;
}

export const NAV: NavItem[] = [
  { href: '/work', label: 'Work', icon: 'inbox', action: 'work.view' },
  { href: '/claims', label: 'Claims', icon: 'file-text', action: 'claim.view' },
  { href: '/remittances', label: 'Remittances', icon: 'landmark', action: 'remittance.view' },
  { href: '/denials', label: 'Denials', icon: 'circle-x', action: 'claim.view' },
  { href: '/tasks', label: 'Manual tasks', icon: 'list-checks', action: 'work.view' },
  { href: '/clients', label: 'Clients', icon: 'building-2', action: 'client.view' },
  { href: '/reports', label: 'Reports', icon: 'chart-column', action: 'reports.view' },
  {
    href: '/integrations',
    label: 'Integrations',
    icon: 'plug-zap',
    admin: true,
    action: 'integration.manage',
  },
  { href: '/settings', label: 'Settings', icon: 'settings', admin: true, action: 'users.manage' },
  { href: '/audit', label: 'Audit log', icon: 'scroll-text', admin: true, action: 'audit.view' },
];
