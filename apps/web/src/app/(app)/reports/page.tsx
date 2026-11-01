import type { Metadata } from 'next';
import { NotBuiltYet } from '@/components/page';

export const metadata: Metadata = { title: 'Reports' };

export default function Page() {
  return (
    <NotBuiltYet title="Reports" view="RP-01" milestone="M4">
      Charges, payments, denial rates and A/R aging appear here per client.
    </NotBuiltYet>
  );
}
