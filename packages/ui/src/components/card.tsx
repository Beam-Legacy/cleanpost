import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../cx';

export function Card({ flush, className, ...props }: HTMLAttributes<HTMLElement> & { flush?: boolean }) {
  return <section className={cx('card', flush && 'flush', className)} {...props} />;
}

export function CardHead({ title, children, level = 2 }: { title: ReactNode; children?: ReactNode; level?: 2 | 3 }) {
  const H = level === 2 ? 'h2' : 'h3';
  return (
    <div className="card-head">
      <H>{title}</H>
      {children && (
        <>
          <span className="spacer" />
          {children}
        </>
      )}
    </div>
  );
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx('card-body', className)} {...props} />;
}

export function CardFoot({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx('card-foot', className)} {...props} />;
}

export interface KpiTileProps {
  label: string;
  value: ReactNode;
  tone?: 'good' | 'bad' | 'warn';
  delta?: { text: string; tone?: 'good' | 'bad' };
  large?: boolean;
}

export function KpiTile({ label, value, tone, delta, large }: KpiTileProps) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className={cx('kpi-value', large && 'lg', tone)}>{value}</div>
      {delta && <div className={cx('kpi-delta', delta.tone)}>{delta.text}</div>}
    </div>
  );
}

export function KpiRow({ children, label }: { children: ReactNode; label: string }) {
  return (
    <section className="kpis" aria-label={label}>
      {children}
    </section>
  );
}
