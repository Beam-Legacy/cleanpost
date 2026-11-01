import type { Metadata } from 'next';
import { NotBuiltYet } from '@/components/page';

export const metadata: Metadata = { title: 'Denials' };

export default function Page() {
  return (
    <NotBuiltYet title="Denials" view="D-01" milestone="M4">
      Denied lines appear here, grouped by category, once payments arrive.
    </NotBuiltYet>
  );
}
