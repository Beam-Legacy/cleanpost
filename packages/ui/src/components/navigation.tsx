import { Check } from 'lucide-react';
import { Tabs as T } from 'radix-ui';
import type { ReactNode } from 'react';
import { cx } from '../cx';

export interface TabDef {
  value: string;
  label: ReactNode;
  content: ReactNode;
}

export function Tabs({ tabs, defaultValue, label }: { tabs: TabDef[]; defaultValue?: string; label: string }) {
  return (
    <T.Root defaultValue={defaultValue ?? tabs[0]?.value}>
      <T.List className="tabs" aria-label={label}>
        {tabs.map((t) => (
          <T.Trigger key={t.value} value={t.value}>
            {t.label}
          </T.Trigger>
        ))}
      </T.List>
      {tabs.map((t) => (
        <T.Content key={t.value} value={t.value} style={{ paddingTop: 16 }}>
          {t.content}
        </T.Content>
      ))}
    </T.Root>
  );
}

export function Segmented<V extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: V; label: string }[];
  value: V;
  onChange: (v: V) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={cx(o.value === value && 'active')}
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function FilterChip({
  label,
  count,
  on,
  onClick,
}: {
  label: string;
  count?: number;
  on?: boolean;
  onClick?: () => void;
}) {
  return (
    <button type="button" className={cx('filter-chip', on && 'on')} aria-pressed={on ?? false} onClick={onClick}>
      {label}
      {count !== undefined && <span className="n">{count}</span>}
    </button>
  );
}

export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="stepper" aria-label="Steps">
      {steps.map((s, i) => {
        const state = i < current ? 'done' : i === current ? 'current' : undefined;
        return (
          <li key={s} className={state} aria-current={state === 'current' ? 'step' : undefined}>
            <span className="n" aria-hidden>
              {state === 'done' ? <Check /> : i + 1}
            </span>
            {s}
            {state === 'done' && <span className="sr-only"> (done)</span>}
          </li>
        );
      })}
    </ol>
  );
}

export interface TimelineEvent {
  title: ReactNode;
  meta: ReactNode;
  tone?: 'info' | 'good' | 'warn' | 'bad';
}

export function Timeline({ events, label }: { events: TimelineEvent[]; label: string }) {
  return (
    <ol className="timeline" aria-label={label}>
      {events.map((e, i) => (
        <li key={i}>
          <span className={cx('tl-dot', e.tone)} aria-hidden />
          <div>
            <div className="tl-title">{e.title}</div>
            <div className="tl-meta">{e.meta}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}

export function KeyValue({ items, figures }: { items: [ReactNode, ReactNode][]; figures?: boolean }) {
  return (
    <dl className={figures ? 'dl' : 'kv'}>
      {items.map(([k, v], i) => (
        <div key={i} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd className={figures ? 'fig' : undefined}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
