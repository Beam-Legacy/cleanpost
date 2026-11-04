import type { Metadata } from 'next';
import { AuthCard } from '@/components/auth-card';
import { safeNext } from '@/lib/next-path';
import { SignInForm } from './sign-in-form';

export const metadata: Metadata = { title: 'Sign in' };

/** A-01 Sign in. `?next=` (a path on this site) is where to go afterwards, e.g. back to A-06. */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const next = safeNext((await searchParams).next);
  return (
    <AuthCard title="Sign in">
      <SignInForm next={next} />
    </AuthCard>
  );
}
