import type { Metadata } from 'next';
import { AuthCard } from '@/components/auth-card';
import { SignInForm } from './sign-in-form';

export const metadata: Metadata = { title: 'Sign in' };

/** A-01 Sign in */
export default function SignInPage() {
  return (
    <AuthCard title="Sign in">
      <SignInForm />
    </AuthCard>
  );
}
