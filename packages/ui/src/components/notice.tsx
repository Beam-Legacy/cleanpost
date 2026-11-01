import { CircleCheck, CircleX, Info, Sparkles, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from '../cx';

const BANNER_ICON = { info: Info, warn: TriangleAlert, bad: CircleX, good: CircleCheck } as const;

export function Banner({
  tone = 'info',
  children,
  edge,
  action,
}: {
  tone?: keyof typeof BANNER_ICON;
  children: ReactNode;
  edge?: boolean;
  action?: ReactNode;
}) {
  const Icon = BANNER_ICON[tone];
  return (
    <div className={cx('banner', tone !== 'info' && tone, edge && 'edge')} role={tone === 'bad' ? 'alert' : 'status'}>
      <Icon aria-hidden />
      <span>{children}</span>
      {action && <span className="spacer" />}
      {action}
    </div>
  );
}

export function Callout({ children }: { children: ReactNode }) {
  return <div className="callout">{children}</div>;
}

/** AI output: always labelled "Suggested" with the sparkles icon and its evidence (docs/06-rules-and-ai.md). */
export function Suggestion({ children, evidence }: { children: ReactNode; evidence?: ReactNode }) {
  return (
    <div className="suggestion">
      <div className="suggestion-head">
        <Sparkles aria-hidden />
        Suggested
      </div>
      <div>{children}</div>
      {evidence && <div className="evidence">{evidence}</div>}
    </div>
  );
}

export function FindingRow({
  severity,
  title,
  meta,
  action,
}: {
  severity: 'block' | 'warn' | 'info';
  title: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
}) {
  const Icon = severity === 'block' ? CircleX : severity === 'warn' ? TriangleAlert : Info;
  const label = severity === 'block' ? 'Blocking' : severity === 'warn' ? 'Warning' : 'Info';
  return (
    <div className={cx('finding', severity === 'block' ? 'bad' : severity === 'warn' && 'warn')}>
      <Icon aria-hidden />
      <div className="body">
        <div className="title">
          <span className="sr-only">{`${label}: `}</span>
          {title}
        </div>
        {meta && <div className="meta">{meta}</div>}
      </div>
      {action}
    </div>
  );
}

export function ConfidenceMeter({ score, threshold }: { score: number; threshold: number }) {
  const passes = score >= threshold;
  return (
    <div className="meter">
      <div className="row-between dense">
        <span className="muted">Confidence</span>
        <span className="num">
          <b>{score}</b> of 100 · releases automatically at {threshold}
        </span>
      </div>
      <div
        className="meter-bar"
        role="meter"
        aria-label="Confidence"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={score}
        aria-valuetext={`${score} of 100; threshold ${threshold}`}
      >
        <div className={cx('meter-fill', passes && 'good')} style={{ width: `${score}%` }} />
        <div className="meter-mark" style={{ left: `${threshold}%` }} />
      </div>
    </div>
  );
}

export function BalanceBar({ balanced, label, children }: { balanced: boolean; label: string; children: ReactNode }) {
  return (
    <div className={cx('balance', !balanced && 'bad')}>
      {balanced ? <CircleCheck aria-hidden /> : <CircleX aria-hidden />}
      <b>{label}</b>
      <span>{children}</span>
    </div>
  );
}
