'use client';
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import { Button, Field, Input } from '@cleanpost/ui';
import { authClient } from '@/lib/auth-client';

export function VerifyForm() {
  const router = useRouter();
  const [mode, setMode] = useState<'totp' | 'recovery'>('totp');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  async function verify(code: string) {
    setBusy(true);
    setError(null);
    const result =
      mode === 'totp'
        ? await authClient.twoFactor.verifyTotp({ code })
        : await authClient.twoFactor.verifyBackupCode({ code });
    setBusy(false);
    if (result.error) {
      setError(
        mode === 'totp'
          ? "That code didn't match. Enter the current code from your app."
          : "That recovery code didn't work.",
      );
      if (input.current) {
        input.current.value = '';
        input.current.focus();
      }
      return;
    }
    router.push('/work');
    router.refresh();
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void verify(String(new FormData(e.currentTarget).get('code') ?? '').trim());
  }

  return (
    <form className="stack" onSubmit={onSubmit} noValidate>
      <p className="muted">
        {mode === 'totp'
          ? 'Open your authenticator app and enter the 6-digit code for Cleanpost.'
          : 'Enter one of the recovery codes you saved when you set up two-factor sign-in. Each works once.'}
      </p>
      <Field label={mode === 'totp' ? 'Code' : 'Recovery code'} error={error}>
        {(p) => (
          <Input
            {...p}
            ref={input}
            name="code"
            mono
            autoFocus
            required
            autoComplete="one-time-code"
            inputMode={mode === 'totp' ? 'numeric' : 'text'}
            pattern={mode === 'totp' ? '[0-9]{6}' : undefined}
            maxLength={mode === 'totp' ? 6 : 32}
            onChange={(e) => {
              if (mode === 'totp' && /^\d{6}$/.test(e.currentTarget.value))
                void verify(e.currentTarget.value);
            }}
          />
        )}
      </Field>
      <Button type="submit" variant="primary" size="lg" block disabled={busy} aria-busy={busy}>
        Verify
      </Button>
      <div className="row" style={{ justifyContent: 'center' }}>
        <Button variant="ghost" size="sm" onClick={() => setMode(mode === 'totp' ? 'recovery' : 'totp')}>
          {mode === 'totp' ? 'Use a recovery code' : 'Use a code from your app'}
        </Button>
      </div>
    </form>
  );
}
