'use client';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { Keyboard, LogOut, Monitor, Moon, Rows3, Sun, UserRound, Building2 } from 'lucide-react';
import { Avatar, Menu, type MenuItem } from '@cleanpost/ui';
import { savePreferences } from '@/app/(app)/preferences';
import { authClient } from '@/lib/auth-client';

/** G-05 User menu: profile, density, theme, switch company, sign out. */
export function UserMenu({ name, canSwitchCompany }: { name: string; canSwitchCompany: boolean }) {
  const router = useRouter();
  const [, start] = useTransition();
  const setPref = (p: Parameters<typeof savePreferences>[0]) =>
    start(async () => {
      await savePreferences(p);
      if (p.theme) document.documentElement.dataset.theme = p.theme === 'system' ? '' : p.theme;
      if (p.theme === 'system') delete document.documentElement.dataset.theme;
      if (p.density) document.documentElement.dataset.density = p.density;
      router.refresh();
    });

  const items: (MenuItem | 'separator')[] = [
    {
      label: 'Profile and security',
      icon: <UserRound aria-hidden />,
      onSelect: () => router.push('/account'),
    },
    'separator',
    { label: 'Compact rows', icon: <Rows3 aria-hidden />, onSelect: () => setPref({ density: 'compact' }) },
    {
      label: 'Comfortable rows',
      icon: <Rows3 aria-hidden />,
      onSelect: () => setPref({ density: 'comfortable' }),
    },
    'separator',
    { label: 'Theme: system', icon: <Monitor aria-hidden />, onSelect: () => setPref({ theme: 'system' }) },
    { label: 'Theme: light', icon: <Sun aria-hidden />, onSelect: () => setPref({ theme: 'light' }) },
    { label: 'Theme: dark', icon: <Moon aria-hidden />, onSelect: () => setPref({ theme: 'dark' }) },
    'separator',
    { label: 'Keyboard shortcuts', meta: '?', icon: <Keyboard aria-hidden />, onSelect: () => {} },
    ...(canSwitchCompany
      ? [
          {
            label: 'Switch company',
            icon: <Building2 aria-hidden />,
            onSelect: () => router.push('/choose-company'),
          },
        ]
      : []),
    {
      label: 'Sign out',
      icon: <LogOut aria-hidden />,
      onSelect: async () => {
        await authClient.signOut();
        router.push('/signed-out?reason=user');
      },
    },
  ];
  return (
    <Menu
      label="Account"
      items={items}
      trigger={
        <button type="button" className="icon-btn ghost" style={{ width: 'auto' }}>
          <span aria-hidden>
            <Avatar name={name} />
          </span>
          <span className="sr-only">{`Account menu for ${name}`}</span>
        </button>
      }
    />
  );
}
