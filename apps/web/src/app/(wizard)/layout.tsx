import type { ReactNode } from 'react';
import { getOffset } from '@cleanpost/clock';
import { TooltipProvider, ToastProvider } from '@cleanpost/ui';
import { ClockOffset } from '@/components/clock-offset';
import { requireActiveContext } from '@/lib/session';

/**
 * Full-page flows outside the app shell (the onboarding wizard, O-01 to O-11). Same sign-in rules
 * as every app page: a signed-in user with a second factor and a chosen company.
 */
export default async function WizardLayout({ children }: { children: ReactNode }) {
  await requireActiveContext();
  return (
    <TooltipProvider>
      <ToastProvider>
        <ClockOffset ms={getOffset()} />
        <div style={{ minHeight: '100vh', background: 'var(--canvas)' }}>{children}</div>
      </ToastProvider>
    </TooltipProvider>
  );
}
