'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Fingerprint } from 'lucide-react';
import { Button, Field, Input } from '@cleanpost/ui';
import { authClient } from '@/lib/auth-client';

export function SignInForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    const { data, error } = await authClient.signIn.email({
      email: String(form.get('email') ?? ''),
      password: String(form.get('password') ?? ''),
    });
    setBusy(false);
    if (error) {
      if (error.code === 'ACCOUNT_LOCKED') return router.push('/account-locked');
      // One generic message: never say whether the email or the password was wrong (A-01).
      return setError('Email or password is incorrect.');
    }
    if (data && 'twoFactorRedirect' in data && data.twoFactorRedirect) return router.push('/sign-in/verify');
    router.push('/work');
    router.refresh();
  }

  async function passkey() {
    setError(null);
    const { error } = await authClient.signIn.passkey();
    if (error) return setError("That passkey didn't work. Try again or use your password.");
    router.push('/work');
    router.refresh();
  }

  return (
    <form className="stack" onSubmit={onSubmit} noValidate>
      <Field label="Work email">
        {(p) => <Input {...p} name="email" type="email" autoComplete="username" required />}
      </Field>
      <div className="field">
        <div className="row-between">
          <label htmlFor="password">Password</label>
          <Link href="/forgot-password" className="dense">
            Forgot password?
          </Link>
        </div>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'sign-in-error' : undefined}
        />
        {error && (
          <span className="error" id="sign-in-error" role="alert">
            {error}
          </span>
        )}
      </div>
      <Button type="submit" variant="primary" size="lg" block disabled={busy} aria-busy={busy}>
        {busy ? 'Signing in…' : 'Sign in'}
      </Button>
      <div className="row" style={{ justifyContent: 'center' }}>
        <span className="subtle">or</span>
      </div>
      <Button size="lg" block onClick={passkey}>
        <Fingerprint aria-hidden />
        Sign in with a passkey
      </Button>
    </form>
  );
}
