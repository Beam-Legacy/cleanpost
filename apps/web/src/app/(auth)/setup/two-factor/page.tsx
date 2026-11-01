import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AuthCard } from '@/components/auth-card';
import { getContext } from '@/lib/session';
import { SetupForm } from './setup-form';

export const metadata: Metadata = { title: 'Set up two-factor sign-in' };

/** A-03 Set up two-factor. Cannot be skipped: every app page sends new users here first. */
export default async function SetupTwoFactorPage() {
  const ctx = await getContext();
  if (ctx.status === 'signed_out') redirect('/sign-in');
  if (ctx.status !== 'mfa_setup_required') redirect('/work');
  return (
    <AuthCard title="Set up two-factor sign-in" wide>
      <SetupForm canSkip={ctx.canSkip} />
    </AuthCard>
  );
}
