'use client';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Button, Callout, Field, Input } from '@cleanpost/ui';
import { AuthCard } from '@/components/auth-card';
import { authClient } from '@/lib/auth-client';

/** A-04 Forgot password. Same answer whether or not the email exists. */
export default function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const email = String(new FormData(e.currentTarget).get('email') ?? '');
    await authClient.requestPasswordReset({ email, redirectTo: `${window.location.origin}/reset-password` });
    setSent(true);
  }

  return (
    <AuthCard title="Reset your password">
      {sent ? (
        <div className="stack">
          <Callout>
            If that email has a Cleanpost account, a reset link is on its way. The link expires in 30 minutes.
          </Callout>
          <Link href="/sign-in">Back to sign in</Link>
        </div>
      ) : (
        <form className="stack" onSubmit={onSubmit} noValidate>
          <p className="muted">Enter your work email and we&apos;ll send a link to set a new password.</p>
          <Field label="Work email">
            {(p) => <Input {...p} name="email" type="email" autoComplete="username" required />}
          </Field>
          <Button type="submit" variant="primary" size="lg" block>
            Send reset link
          </Button>
          <Link href="/sign-in" className="dense">
            Back to sign in
          </Link>
        </form>
      )}
    </AuthCard>
  );
}
