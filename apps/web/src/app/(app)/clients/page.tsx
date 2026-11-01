import type { Metadata } from 'next';
import { NotBuiltYet } from '@/components/page';

export const metadata: Metadata = { title: 'Clients' };

export default function Page() {
  return (
    <NotBuiltYet title="Clients" view="CL-01" milestone="M1">
      The practices your company serves appear here, with their PM connection and mode.
    </NotBuiltYet>
  );
}
