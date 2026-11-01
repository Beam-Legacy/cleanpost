import type { Metadata } from 'next';
import { NotBuiltYet } from '@/components/page';

export const metadata: Metadata = { title: 'Manual tasks' };

export default function Page() {
  return (
    <NotBuiltYet title="Manual tasks" view="M-03" milestone="M3">
      Work Cleanpost prepares for you to finish in a PM appears here.
    </NotBuiltYet>
  );
}
