'use client';
/**
 * A-06 for a new person: email (fixed), full name, password, terms. Then they are signed in, set up
 * two-factor (A-03) and come back to the invite to join.
 */
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field, Input } from '@cleanpost/ui';
import { authClient } from '@/lib/auth-client';
import { acceptAsNewUserAction } from './actions';

export function AcceptForm({ token, email, minLength }: { token: string; email: string; minLength: number }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const password = String(form.get('password') ?? '');
    setBusy(true);
    setError(null);
    const res = await acceptAsNewUserAction({
      token,
      name: String(form.get('name') ?? ''),
      password,
      terms: form.get('terms') === 'on',
    });
    if (!res.ok) {
      setBusy(false);
      return setError(res.message);
    }
    const signedIn = await authClient.signIn.email({ email: res.email, password });
    setBusy(false);
    if (signedIn.error) return router.push('/sign-in');
    // Joining waits for a second factor (A-03); setup brings them back here to join.
    router.push(`/setup/two-factor?next=${encodeURIComponent(`/invite?token=${encodeURIComponent(token)}`)}`);
    router.refresh();
  }

  return (
    <form method="post" className="stack" onSubmit={onSubmit} noValidate>
      <Field label="Work email">
        {(p) => <Input {...p} value={email} readOnly aria-readonly autoComplete="username" />}
      </Field>
      <Field label="Full name">
        {(p) => <Input {...p} name="name" autoComplete="name" required maxLength={120} />}
      </Field>
      <Field label="Password" help={`At least ${minLength} characters.`}>
        {(p) => (
          <Input
            {...p}
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={minLength}
            maxLength={128}
          />
        )}
      </Field>
      <label className="check">
        <input type="checkbox" name="terms" required />
        <span>I agree to the terms of use and will follow my company&apos;s HIPAA policies.</span>
      </label>
      {error && (
        <span className="error" role="alert">
          {error}
        </span>
      )}
      <Button type="submit" variant="primary" size="lg" block disabled={busy} aria-busy={busy}>
        {busy ? 'Creating your account…' : 'Create account'}
      </Button>
    </form>
  );
}
