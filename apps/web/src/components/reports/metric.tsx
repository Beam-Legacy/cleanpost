'use client';
/**
 * A report KPI (RP-01, RP-02) with RP-07: the info button opens the metric's definition with the
 * numbers behind this value, so a billing company can defend the figure to its practice. Opens on
 * click or Enter, Esc closes.
 */
import { Info } from 'lucide-react';
import { reports } from '@cleanpost/domain';
import { Popover } from '@cleanpost/ui';
import { formatValue, type Unit } from '@/lib/report-display';

export interface MetricProps {
  metric: reports.MetricKey;
  value: number | null;
  unit: Unit;
  /** e.g. "+9% vs September", with its tone (green only when good for the business). */
  delta?: { text: string; tone: reports.Tone } | null;
  /** The value worked out with this report's numbers, e.g. "$142,880 ÷ $5,953 = 24.0". */
  working?: string | null;
  scope: string;
  large?: boolean;
}

export function MetricTile({ metric, value, unit, delta, working, scope, large = true }: MetricProps) {
  const d = reports.METRICS[metric];
  return (
    <div className="kpi">
      <div className="kpi-label">
        {d.label}
        <Popover
          label={`How ${d.label.toLowerCase()} is calculated`}
          trigger={
            <button
              type="button"
              className="icon-btn ghost"
              style={{ width: 24, height: 24 }}
              aria-label={`How ${d.label.toLowerCase()} is calculated`}
            >
              <Info aria-hidden size={14} />
            </button>
          }
        >
          <div className="stack-sm" style={{ maxWidth: 320 }}>
            <div className="row-between">
              <b>{d.label}</b>
              <span className="muted dense">{scope}</span>
            </div>
            <span>{d.meaning}</span>
            <span className="dense">{d.formula}</span>
            {working ? (
              <span className="code dense">{working}</span>
            ) : (
              <span className="muted dense">Not enough data in this period to show the numbers.</span>
            )}
            <dl className="kv dense" style={{ margin: 0 }}>
              <dt>Includes</dt>
              <dd>{d.includes}</dd>
              <dt>Excludes</dt>
              <dd>{d.excludes}</dd>
            </dl>
          </div>
        </Popover>
      </div>
      <div className={`kpi-value${large ? ' lg' : ''}`}>{formatValue(value, unit)}</div>
      {delta && (
        <div className={`kpi-delta${delta.tone === 'neutral' ? '' : ` ${delta.tone}`}`}>{delta.text}</div>
      )}
    </div>
  );
}
