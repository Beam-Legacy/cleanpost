import type { Metadata } from 'next';
import Link from 'next/link';
import { AuthCard } from '@/components/auth-card';

export const metadata: Metadata = { title: 'Signed out' };

const COPY = {
  idle: [
    'You were signed out',
    'You were inactive for 15 minutes, so we signed you out to protect patient information.',
  ],
  expired: [
    'Your session reached its 12-hour limit',
    'Sessions end after 12 hours, even when active. Sign in again to continue.',
  ],
  admin: ['An admin signed you out', 'Your admin ended your session. If you need access, contact them.'],
  user: ['You signed out', 'Sign in again whenever you are ready.'],
} as const;

/** G-10 Signed out. No PHI; the return path is a route only. */
export default async function SignedOutPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason } = await searchParams;
  const [title, body] = COPY[(reason as keyof typeof COPY) ?? 'user'] ?? COPY.user;
  return (
    <AuthCard title={title}>
      <p className="muted">{body}</p>
      <Link className="btn btn-primary btn-lg btn-block" href="/sign-in">
        Sign in again
      </Link>
    </AuthCard>
  );
}
