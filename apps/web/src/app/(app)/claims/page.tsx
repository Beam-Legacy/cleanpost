import type { Metadata } from 'next';
import { NotBuiltYet } from '@/components/page';

export const metadata: Metadata = { title: 'Claims' };

export default function Page() {
  return (
    <NotBuiltYet title="Claims" view="C-01" milestone="M2">
      Claims appear here once Cleanpost pulls charges from a client's PM and builds them.
    </NotBuiltYet>
  );
}
