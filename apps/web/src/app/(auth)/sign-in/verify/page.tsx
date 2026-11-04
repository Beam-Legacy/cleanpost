import type { Metadata } from 'next';
import { AuthCard } from '@/components/auth-card';
import { safeNext } from '@/lib/next-path';
import { VerifyForm } from './verify-form';

export const metadata: Metadata = { title: 'Two-factor sign-in' };

/** A-02 Second factor */
export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const next = safeNext((await searchParams).next);
  return (
    <AuthCard title="Enter your code">
      <VerifyForm next={next} />
    </AuthCard>
  );
}
