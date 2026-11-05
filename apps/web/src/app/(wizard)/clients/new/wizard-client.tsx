'use client';
/** Shared wizard pieces that run in the browser: calling a step's action, the footer, polling. */
import { useEffect, useState, useTransition, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, useToast } from '@cleanpost/ui';

export interface StepResult {
  ok: boolean;
  message: string;
  next?: string;
}

/** Run an action: go to `next` when the step moved on, otherwise refresh and say what happened. */
export function useStepAction() {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const toast = useToast();
  const run = (fn: () => Promise<StepResult>, opts: { quiet?: boolean } = {}) =>
    start(async () => {
      setError(null);
      const res = await fn();
      if (!res.ok) {
        setError(res.message);
        if (res.next) router.push(res.next);
        return;
      }
      if (res.next) return router.push(res.next);
      if (!opts.quiet) toast({ message: res.message });
      router.refresh();
    });
  return { pending, error, run, setError };
}

export function StepError({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="dense" style={{ color: 'var(--danger)', margin: 0 }}>
      {error}
    </p>
  );
}

/** Back (a link to the previous step) and the step's primary action. */
export function StepFoot({
  back,
  children,
  aside,
}: {
  back: string | null;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className="wizard-foot">
      {back ? (
        <Link className="btn btn-secondary" href={back}>
          Back
        </Link>
      ) : (
        <span />
      )}
      <span className="row" style={{ gap: 12 }}>
        {aside}
        {children}
      </span>
    </div>
  );
}

export function ContinueButton({
  label = 'Continue',
  disabled,
  action,
}: {
  label?: string;
  disabled?: boolean;
  action: () => Promise<StepResult>;
}) {
  const { pending, error, run } = useStepAction();
  return (
    <span className="stack-sm" style={{ alignItems: 'flex-end' }}>
      <Button variant="primary" disabled={disabled || pending} onClick={() => run(action)}>
        {pending ? 'Saving…' : label}
      </Button>
      <StepError error={error} />
    </span>
  );
}

/**
 * Refresh the page every `ms` while `active` (the worker is testing, pulling or syncing), for at
 * most `forMs`; then show that it is taking longer than it should.
 */
export function Poll({
  active,
  ms = 2000,
  forMs = 90_000,
}: {
  active: boolean;
  ms?: number;
  forMs?: number;
}) {
  const router = useRouter();
  const [gaveUp, setGaveUp] = useState(false);
  useEffect(() => {
    if (!active) return;
    setGaveUp(false);
    const started = Date.now();
    const t = setInterval(() => {
      if (Date.now() - started > forMs) {
        clearInterval(t);
        setGaveUp(true);
        return;
      }
      router.refresh();
    }, ms);
    return () => clearInterval(t);
  }, [active, ms, forMs, router]);
  if (!active || !gaveUp) return null;
  return (
    <p className="dense muted" style={{ margin: 0 }}>
      This is taking longer than usual. The worker may be busy; reload the page to check again.
    </p>
  );
}
