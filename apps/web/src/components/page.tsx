import type { ReactNode } from 'react';
import { Lock } from 'lucide-react';
import { EmptyState } from '@cleanpost/ui';

export function PageHead({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="page-head">
      <h1>{title}</h1>
      {subtitle && <span className="muted">{subtitle}</span>}
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

/** Pages whose content lands in a later milestone (docs/16-milestones.md). */
export function NotBuiltYet({
  title,
  view,
  milestone,
  children,
}: {
  title: string;
  view: string;
  milestone: string;
  children: ReactNode;
}) {
  return (
    <>
      <PageHead title={title} />
      <EmptyState title="Not built yet" tone="neutral">
        {children}{' '}
        <span className="subtle">
          Built in milestone {milestone} (view {view}).
        </span>
      </EmptyState>
    </>
  );
}

/** G-23 No access. */
export function NoAccess() {
  return (
    <EmptyState title="You don't have access to this page" tone="neutral" icon={<Lock />}>
      Ask an admin in your company if you need it. Nothing was changed.
    </EmptyState>
  );
}
