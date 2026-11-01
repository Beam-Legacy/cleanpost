import type { Metadata } from 'next';
import Link from 'next/link';
import { AuthCard } from '@/components/auth-card';

export const metadata: Metadata = { title: 'Account locked' };

/** A-08 Account locked (temporary). */
export default function AccountLockedPage() {
  return (
    <AuthCard title="Sign-in paused for 15 minutes">
      <p className="muted">
        The password was entered incorrectly too many times, so sign-in is paused for this account. We emailed
        the account owner. Try again in 15 minutes, or reset the password now.
      </p>
      <div className="row">
        <Link className="btn btn-primary" href="/forgot-password">
          Reset password
        </Link>
        <Link className="btn btn-secondary" href="/sign-in">
          Back to sign in
        </Link>
      </div>
    </AuthCard>
  );
}
