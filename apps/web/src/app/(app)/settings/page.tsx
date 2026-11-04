import { redirect } from 'next/navigation';

/** Settings opens on Users and roles (S-01). */
export default function SettingsPage() {
  redirect('/settings/users');
}
