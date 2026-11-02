import { CircleX, Inbox } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { cx } from '../cx';

/** G-21 Empty: says what will appear here and what to do next. */
export function EmptyState({
  title,
  children,
  icon,
  tone,
  action,
}: {
  title: string;
  children?: ReactNode;
  icon?: ReactNode;
  tone?: 'good' | 'bad' | 'neutral';
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className={cx('glyph', tone)} aria-hidden>
        {icon ?? <Inbox />}
      </div>
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {action && (
        <div className="row" style={{ justifyContent: 'center', marginTop: 8 }}>
          {action}
        </div>
      )}
    </div>
  );
}

/** G-22 Error: what failed, whether data is safe, and the next action. Never raw error text. */
export function ErrorState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty" role="alert">
      <div className="glyph bad" aria-hidden>
        <CircleX />
      </div>
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {action && (
        <div className="row" style={{ justifyContent: 'center', marginTop: 8 }}>
          {action}
        </div>
      )}
    </div>
  );
}

/** G-20 Loading: skeletons, never full-page spinners. */
export function Skeleton({
  width,
  height,
  style,
}: {
  width?: number | string;
  height?: number;
  style?: CSSProperties;
}) {
  return <div className="skeleton" aria-hidden style={{ width, height, ...style }} />;
}

export function SkeletonRows({ rows = 5, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div className="stack-sm" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} width={`${90 - (i % 3) * 15}%`} />
      ))}
    </div>
  );
}
