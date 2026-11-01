'use client';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Modal } from '@cleanpost/ui';
import { authClient } from '@/lib/auth-client';

const IDLE_MS = 15 * 60 * 1000;
const WARN_MS = 60 * 1000;
const KEEPALIVE_MS = 60 * 1000;

/**
 * G-09 Session timeout warning. Activity keeps the server session alive (at most one refresh a
 * minute); after 14 idle minutes a 60-second countdown starts; at zero the user is signed out (G-10).
 * The 12-hour absolute limit is enforced on the server and cannot be extended here.
 */
export function SessionTimeout() {
  const router = useRouter();
  const lastActivity = useRef(Date.now());
  const lastKeepalive = useRef(Date.now());
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  const signOut = useCallback(async () => {
    await authClient.signOut();
    router.push('/signed-out?reason=idle');
  }, [router]);

  const stay = useCallback(async () => {
    lastActivity.current = Date.now();
    lastKeepalive.current = Date.now();
    setSecondsLeft(null);
    await authClient.getSession();
  }, []);

  useEffect(() => {
    const onActivity = () => {
      if (secondsLeft !== null) return; // during the warning, only the buttons count
      lastActivity.current = Date.now();
      if (Date.now() - lastKeepalive.current > KEEPALIVE_MS) {
        lastKeepalive.current = Date.now();
        void authClient.getSession();
      }
    };
    const events = ['pointerdown', 'keydown', 'scroll'] as const;
    events.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));
    const timer = setInterval(() => {
      const idle = Date.now() - lastActivity.current;
      if (idle >= IDLE_MS) void signOut();
      else if (idle >= IDLE_MS - WARN_MS) setSecondsLeft(Math.ceil((IDLE_MS - idle) / 1000));
    }, 1000);
    return () => {
      events.forEach((e) => window.removeEventListener(e, onActivity));
      clearInterval(timer);
    };
  }, [secondsLeft, signOut]);

  const announce = secondsLeft !== null && [60, 30, 10].includes(secondsLeft);
  return (
    <Modal
      open={secondsLeft !== null}
      onOpenChange={(o) => !o && void stay()}
      size="sm"
      title="You'll be signed out soon"
      footer={
        <>
          <Button onClick={() => void signOut()}>Sign out now</Button>
          <Button variant="primary" onClick={() => void stay()}>
            Stay signed in
          </Button>
        </>
      }
    >
      <p>
        For security, Cleanpost signs you out after 15 minutes without activity. Signing out in{' '}
        <b className="num">{secondsLeft ?? 0}</b> seconds.
      </p>
      <p className="sr-only" aria-live="assertive">
        {announce ? `Signing out in ${secondsLeft} seconds` : ''}
      </p>
    </Modal>
  );
}
