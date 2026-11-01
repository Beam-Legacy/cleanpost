'use client';
import { Button, useToast } from '@cleanpost/ui';
import { authClient } from '@/lib/auth-client';

export function SignOutOthers() {
  const toast = useToast();
  return (
    <Button
      onClick={async () => {
        const { error } = await authClient.revokeOtherSessions();
        toast(
          error
            ? { message: "Couldn't sign out other sessions. Try again.", tone: 'bad' }
            : { message: 'Other sessions signed out.' },
        );
      }}
    >
      Sign out of other sessions
    </Button>
  );
}
