import type { Metadata } from 'next';
import { NotBuiltYet } from '@/components/page';

export const metadata: Metadata = { title: 'Remittances' };

export default function Page() {
  return (
    <NotBuiltYet title="Remittances" view="R-01" milestone="M3">
      Payments appear here once 835 files are read from a PM or uploaded.
    </NotBuiltYet>
  );
}
