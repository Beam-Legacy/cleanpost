import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AuthCard } from '@/components/auth-card';
import { safeNext } from '@/lib/next-path';
import { getContext } from '@/lib/session';
import { SetupForm } from './setup-form';

export const metadata: Metadata = { title: 'Set up two-factor sign-in' };

/** A-03 Set up two-factor. Cannot be skipped: every app page sends new users here first. */
export default async function SetupTwoFactorPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const next = safeNext((await searchParams).next);
  const ctx = await getContext();
  if (ctx.status === 'signed_out') redirect('/sign-in');
  if (ctx.status !== 'mfa_setup_required') redirect(next);
  return (
    <AuthCard title="Set up two-factor sign-in" wide>
      <SetupForm canSkip={ctx.canSkip} next={next} />
    </AuthCard>
  );
}
