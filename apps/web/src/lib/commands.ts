/**
 * G-03 commands: going to each section the person may open, and the common actions their role
 * allows. Typed ">" first to see only commands.
 */
import type { policy, search } from '@cleanpost/domain';
import { NAV } from './nav';

export interface PaletteCommand extends search.Command {
  icon: 'arrow-right' | 'upload' | 'plus' | 'user-plus' | 'bell' | 'user' | 'chart-column';
}

const ACTIONS: (PaletteCommand & { action?: policy.Action })[] = [
  {
    id: 'upload-835',
    label: 'Upload 835 file',
    href: '/remittances?upload=1',
    hint: 'Remittances',
    icon: 'upload',
    keywords: ['era', 'remittance', 'payment'],
    action: 'payment.post',
  },
  {
    id: 'add-client',
    label: 'Add client',
    href: '/clients/new/practice',
    hint: 'Clients',
    icon: 'plus',
    keywords: ['onboard', 'practice', 'new'],
    action: 'client.create',
  },
  {
    id: 'invite-user',
    label: 'Invite user',
    href: '/settings/users?invite=1',
    hint: 'Settings',
    icon: 'user-plus',
    keywords: ['people', 'team', 'add'],
    action: 'users.manage',
  },
  {
    id: 'notification-settings',
    label: 'Notification settings',
    href: '/settings/notifications',
    hint: 'Settings',
    icon: 'bell',
    keywords: ['alerts', 'digest', 'email'],
    action: 'users.manage',
  },
  {
    id: 'aging',
    label: 'Open the aging report',
    href: '/reports/aging',
    hint: 'Reports',
    icon: 'chart-column',
    keywords: ['ar', 'balances'],
    action: 'reports.view',
  },
  {
    id: 'profile',
    label: 'Profile and security',
    href: '/account',
    icon: 'user',
    keywords: ['account', 'password', 'two-factor', 'email'],
  },
];

export function commandsFor(allowed: readonly policy.Action[]): PaletteCommand[] {
  const go = NAV.filter((n) => allowed.includes(n.action)).map((n) => ({
    id: `go-${n.href}`,
    label: `Go to ${n.label.toLowerCase()}`,
    href: n.href,
    icon: 'arrow-right' as const,
    keywords: [n.label.toLowerCase()],
  }));
  const actions = ACTIONS.filter((a) => !a.action || allowed.includes(a.action)).map(
    ({ action: _action, ...c }) => c,
  );
  return [...actions, ...go];
}
