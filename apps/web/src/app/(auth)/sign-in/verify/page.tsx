import type { Metadata } from 'next';
import { AuthCard } from '@/components/auth-card';
import { safeNext } from '@/lib/next-path';
import { canTrustDevice } from '@/lib/sign-in';
import { VerifyForm } from './verify-form';

export const metadata: Metadata = { title: 'Two-factor sign-in' };

/** A-02 Second factor. "Trust this device" only where every company of the person allows it (S-12). */
export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const next = safeNext((await searchParams).next);
  return (
    <AuthCard title="Enter your code">
      <VerifyForm next={next} canTrust={await canTrustDevice()} />
    </AuthCard>
  );
}
