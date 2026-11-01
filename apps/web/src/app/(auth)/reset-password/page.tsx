'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { Button, Field, Input } from '@cleanpost/ui';
import { AuthCard } from '@/components/auth-card';
import { authClient } from '@/lib/auth-client';

/** A-05 Reset password. Resetting signs out other sessions; two-factor is still required after. */
export default function ResetPasswordPage() {
  return (
    <AuthCard title="Set a new password">
      <Suspense>
        <ResetForm />
      </Suspense>
    </AuthCard>
  );
}

function ResetForm() {
  const router = useRouter();
  const token = useSearchParams().get('token');
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const password = String(form.get('password') ?? '');
    if (password !== String(form.get('confirm') ?? '')) return setError('The passwords don’t match.');
    const { error } = await authClient.resetPassword({ newPassword: password, token: token ?? '' });
    if (error) return setError('This link has expired or was already used. Ask for a new one.');
    router.push('/sign-in');
  }

  if (!token) {
    return (
      <p className="muted">
        This link is missing its token. <Link href="/forgot-password">Ask for a new link</Link>.
      </p>
    );
  }
  return (
    <form className="stack" onSubmit={onSubmit} noValidate>
      <Field label="New password" help="At least 12 characters. A short sentence works well.">
        {(p) => (
          <Input {...p} name="password" type="password" autoComplete="new-password" minLength={12} required />
        )}
      </Field>
      <Field label="Confirm new password" error={error}>
        {(p) => <Input {...p} name="confirm" type="password" autoComplete="new-password" required />}
      </Field>
      <Button type="submit" variant="primary" size="lg" block>
        Set password
      </Button>
    </form>
  );
}
