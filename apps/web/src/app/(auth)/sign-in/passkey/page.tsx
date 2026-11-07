import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AuthCard } from '@/components/auth-card';
import { safeNext } from '@/lib/next-path';
import { getContext } from '@/lib/session';
import { PasskeyStep } from './passkey-step';

export const metadata: Metadata = { title: 'Confirm with your passkey' };

/**
 * A-02 for someone whose second factor is a passkey and who signed in with their password: the
 * passkey is still owed before anything else (DEC-34).
 */
export default async function PasskeyStepPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await getContext();
  const next = safeNext((await searchParams).next);
  if (ctx.status === 'signed_out') redirect('/sign-in');
  if (ctx.status !== 'second_factor_required') redirect(next);
  return (
    <AuthCard title="Confirm with your passkey">
      <PasskeyStep next={next} />
    </AuthCard>
  );
}
