'use client';
import { Button, ErrorState } from '@cleanpost/ui';

/** G-22 Error: what failed, whether data is safe, the next action. Never shows raw error text. */
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <ErrorState
      title="This page didn't load"
      action={
        <Button variant="primary" onClick={reset}>
          Try again
        </Button>
      }
    >
      Your data is safe; nothing was changed. If this keeps happening, use Get help so we can look.
    </ErrorState>
  );
}
