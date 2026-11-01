import Link from 'next/link';
import { Compass } from 'lucide-react';
import { EmptyState } from '@cleanpost/ui';

/** G-24 Not found. */
export default function NotFound() {
  return (
    <main className="main">
      <EmptyState
        title="This page doesn't exist"
        tone="neutral"
        icon={<Compass />}
        action={
          <Link className="btn btn-primary" href="/work">
            Go to Work
          </Link>
        }
      >
        The link may be old, or the record was removed. Nothing was changed.
      </EmptyState>
    </main>
  );
}
