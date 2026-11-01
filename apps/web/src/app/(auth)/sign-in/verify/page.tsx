import type { Metadata } from 'next';
import { AuthCard } from '@/components/auth-card';
import { VerifyForm } from './verify-form';

export const metadata: Metadata = { title: 'Two-factor sign-in' };

/** A-02 Second factor */
export default function VerifyPage() {
  return (
    <AuthCard title="Enter your code">
      <VerifyForm />
    </AuthCard>
  );
}
