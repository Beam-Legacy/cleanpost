import { Tooltip as T } from 'radix-ui';
import type { ReactElement, ReactNode } from 'react';

export function TooltipProvider({ children }: { children: ReactNode }) {
  return <T.Provider delayDuration={400}>{children}</T.Provider>;
}

export function Tooltip({ content, children }: { content: ReactNode; children: ReactElement }) {
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content className="tooltip" sideOffset={6}>
          {content}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
