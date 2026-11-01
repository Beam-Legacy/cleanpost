import type { ReactNode } from 'react';
import { LogoMark } from '@cleanpost/ui';

/** Shared frame for sign-in screens (A-01 to A-08, G-10): logo, one card, PHI notice. No PHI on these pages. */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 px-4 py-12">
      <div className="side-brand" style={{ padding: 0, fontSize: 22 }}>
        <LogoMark size={26} />
        <span>cleanpost</span>
      </div>
      <main className="w-full max-w-[400px]">{children}</main>
      <p className="subtle">Protected health information. Access is logged.</p>
    </div>
  );
}
