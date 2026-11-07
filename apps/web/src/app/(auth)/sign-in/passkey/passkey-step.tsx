'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Fingerprint } from 'lucide-react';
import { Button } from '@cleanpost/ui';
import { authClient } from '@/lib/auth-client';
import { DEFAULT_NEXT } from '@/lib/next-path';

/** A password is one step: the passkey on this device is the second (A-02, DEC-34). */
export function PasskeyStep({ next = DEFAULT_NEXT }: { next?: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function usePasskey() {
    setBusy(true);
    setError(null);
    const { error } = await authClient.signIn.passkey();
    setBusy(false);
    if (error) return setError("That passkey didn't work. Try again, or sign out and use another device.");
    router.push(next);
    router.refresh();
  }

  async function signOut() {
    await authClient.signOut();
    router.push('/sign-in');
    router.refresh();
  }

  return (
    <div className="stack">
      <p className="muted">
        Your password is right. Your second sign-in step is a passkey: use the one on this device to finish
        signing in.
      </p>
      {error && (
        <span className="error" role="alert">
          {error}
        </span>
      )}
      <Button variant="primary" size="lg" block onClick={usePasskey} disabled={busy} aria-busy={busy}>
        <Fingerprint aria-hidden />
        Use your passkey
      </Button>
      <div className="row" style={{ justifyContent: 'center' }}>
        <Button variant="ghost" size="sm" onClick={signOut}>
          Sign out
        </Button>
      </div>
    </div>
  );
}
