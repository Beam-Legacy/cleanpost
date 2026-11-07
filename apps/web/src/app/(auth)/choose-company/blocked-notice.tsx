'use client';
/**
 * A-07: why a company turned this sign-in away (S-12, DEC-34), and the way back in. A company that
 * does not accept passkeys or trusted devices asks for the authenticator code: sign out and sign in
 * with it (a trusted device is forgotten first). An IP allowlist only says where sign-in works.
 */
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { Banner, Button } from '@cleanpost/ui';
import { authClient } from '@/lib/auth-client';
import { forgetThisDeviceAction } from './actions';

export type BlockedReason = 'passkeys_not_allowed' | 'trusted_devices_not_allowed' | 'network';

export function BlockedNotice({
  reason,
  company,
  address,
}: {
  reason: BlockedReason;
  company: string;
  address: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const signInWithCode = () =>
    start(async () => {
      if (reason === 'trusted_devices_not_allowed') await forgetThisDeviceAction();
      await authClient.signOut();
      router.push('/sign-in');
      router.refresh();
    });
  const text =
    reason === 'passkeys_not_allowed'
      ? `${company} asks for your authenticator code at sign-in, not a passkey. Sign in with your password and code. No authenticator app set up? Ask an admin at ${company} to reset your two-factor sign-in.`
      : reason === 'trusted_devices_not_allowed'
        ? `${company} asks for your authenticator code at every sign-in, so this device no longer skips it.`
        : `${company} only allows sign-in from its own network${address ? `, and this connection comes from ${address}` : ''}. Connect from an office network or ask an admin at ${company} to add this address.`;
  return (
    <div className="stack-sm">
      <Banner tone="warn">{text}</Banner>
      {reason !== 'network' && (
        <Button variant="primary" block disabled={pending} onClick={signInWithCode}>
          Sign in with your code
        </Button>
      )}
    </div>
  );
}
