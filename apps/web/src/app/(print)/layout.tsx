import type { ReactNode } from 'react';
import { requireActiveContext } from '@/lib/session';

/** Printable documents (F-01): signed in like the app, without the app shell. */
export default async function PrintLayout({ children }: { children: ReactNode }) {
  await requireActiveContext();
  return <main className="print-doc">{children}</main>;
}
