'use client';
/**
 * Report charts (RP-01 to RP-05), drawn as SVG on the design tokens: chart-1 to chart-4 for series
 * in fixed order, chart-5 for "Other" next to chart-1 (palette validated for color-vision separation
 * in both themes, docs/10). Every chart has a table view (Chart/Table toggle) and a tooltip on
 * hover and keyboard focus; the table holds every value, so the tooltip never gates one.
 */
import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Segmented } from '@cleanpost/ui';

import { formatValue, type Unit } from '@/lib/report-display';

const shortDate = (ymd: string) =>
  new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

/** A card with a Chart/Table toggle (the table is every value, for every reader). */
export function ChartCard({
  title,
  note,
  chart,
  table,
}: {
  title: string;
  note?: ReactNode;
  chart: ReactNode;
  table: ReactNode;
}) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  return (
    <div className="card">
      <div className="card-head">
        <h2>{title}</h2>
        <div style={{ marginLeft: 'auto' }}>
          <Segmented
            label={`${title}: view`}
            value={view}
            onChange={setView}
            options={[
              { value: 'chart', label: 'Chart' },
              { value: 'table', label: 'Table' },
            ]}
          />
        </div>
      </div>
      <div className="card-body">
        {view === 'chart' ? chart : table}
        {note && (
          <p className="subtle dense" style={{ margin: '8px 0 0' }}>
            {note}
          </p>
        )}
      </div>
    </div>
  );
}

/** Clean axis ticks: four or five round steps covering the values. */
function ticks(min: number, max: number, unit: Unit): number[] {
  if (max === min) max = min + 1;
  const raw = (max - min) / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const lo = Math.floor(min / step) * step;
  const out: number[] = [];
  for (let v = lo; v <= max + step * 0.001; v += step) out.push(Math.round(v * 1000) / 1000);
  if (out.length < 2) out.push(lo + step);
  return unit === 'percent' ? out.filter((v) => v >= 0 && v <= 100) : out.filter((v) => v >= 0);
}

const W = 720;
const H = 250;
const L = 60;
const R = 700;
const TOP = 30;
const BASE = 200;

function Tip({ x, children }: { x: number; children: ReactNode }) {
  return (
    <div className="chart-tip" role="status" style={{ left: `${(x / W) * 100}%` }}>
      {children}
    </div>
  );
}

/** One series by week (a single line needs no legend: the title names it). */
export function WeeklyLine({
  points,
  unit,
  label,
}: {
  points: { week: string; value: number | null; detail?: string }[];
  unit: Unit;
  label: string;
}) {
  const [at, setAt] = useState<number | null>(null);
  const values = points.map((p) => p.value).filter((v): v is number => v !== null);
  if (!values.length) return <p className="muted">No data in this period.</p>;
  const t = ticks(Math.min(...values), Math.max(...values), unit);
  const lo = t[0]!;
  const hi = t.at(-1)!;
  const x = (i: number) => (points.length === 1 ? (L + R) / 2 : L + (i * (R - L)) / (points.length - 1));
  const y = (v: number) => BASE - ((v - lo) / (hi - lo || 1)) * (BASE - TOP);
  const drawn = points.map((p, i) => (p.value === null ? null : ([x(i), y(p.value)] as const)));
  const path = drawn
    .filter(Boolean)
    .map((d) => `${d![0]},${d![1]}`)
    .join(' ');
  const last = [...drawn.keys()].reverse().find((i) => drawn[i]);
  const every = Math.ceil(points.length / 8);
  const move = (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight') setAt((a) => Math.min(points.length - 1, (a ?? -1) + 1));
    if (e.key === 'ArrowLeft') setAt((a) => Math.max(0, (a ?? points.length) - 1));
  };
  const cur = at === null ? null : points[at];
  return (
    <div className="chart-wrap">
      <svg
        className="chart-svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={label}
        tabIndex={0}
        onFocus={() => setAt((a) => a ?? last ?? 0)}
        onBlur={() => setAt(null)}
        onKeyDown={move}
        onPointerLeave={() => setAt(null)}
        onPointerMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - box.left) / box.width) * W;
          const i = Math.round(((px - L) / (R - L)) * (points.length - 1));
          setAt(Math.max(0, Math.min(points.length - 1, i)));
        }}
      >
        {t.map((v) => (
          <g key={v}>
            <line className="grid" x1={L} x2={R} y1={y(v)} y2={y(v)} />
            <text className="axis" x={L - 10} y={y(v) + 4} textAnchor="end">
              {unit === 'percent' ? `${v}%` : formatValue(v, unit)}
            </text>
          </g>
        ))}
        {points.map((p, i) =>
          i % every === 0 ? (
            <text key={p.week} className="axis" x={x(i)} y={H - 14} textAnchor="middle">
              {shortDate(p.week)}
            </text>
          ) : null,
        )}
        {at !== null && <line className="crosshair" x1={x(at)} x2={x(at)} y1={TOP - 10} y2={BASE} />}
        <polyline
          points={path}
          fill="none"
          stroke="var(--chart-1)"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {last !== undefined && drawn[last] && (
          <>
            <circle
              cx={drawn[last]![0]}
              cy={drawn[last]![1]}
              r={4}
              fill="var(--chart-1)"
              stroke="var(--surface)"
              strokeWidth={2}
            />
            <text className="axis value" x={drawn[last]![0]} y={drawn[last]![1] - 12} textAnchor="end">
              {formatValue(points[last]!.value, unit)}
            </text>
          </>
        )}
        {at !== null && drawn[at] && (
          <circle
            cx={drawn[at]![0]}
            cy={drawn[at]![1]}
            r={5}
            fill="var(--chart-1)"
            stroke="var(--surface)"
            strokeWidth={2}
          />
        )}
      </svg>
      {cur && at !== null && (
        <Tip x={x(at)}>
          <b>{formatValue(cur.value, unit)}</b>
          <span>Week of {shortDate(cur.week)}</span>
          {cur.detail && <span className="subtle">{cur.detail}</span>}
        </Tip>
      )}
    </div>
  );
}

export const SERIES_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)'];
export const OTHER_COLOR = 'var(--chart-5)';

/**
 * Weekly columns stacked by series. "Other" (the last series, when named so) is drawn at the
 * bottom next to chart-1, in the neutral gray; 2px surface gaps separate the segments.
 */
export function StackedWeekly({
  weeks,
  series,
  label,
}: {
  weeks: { week: string; values: number[] }[];
  series: string[];
  label: string;
}) {
  const [at, setAt] = useState<number | null>(null);
  const legendId = useId();
  const color = (s: number) =>
    series[s] === 'Other' ? OTHER_COLOR : SERIES_COLORS[s % SERIES_COLORS.length]!;
  // Bottom to top: Other first (beside chart-1), then the series in order.
  const order = [...series.keys()].sort((a, b) =>
    series[a] === 'Other' ? -1 : series[b] === 'Other' ? 1 : a - b,
  );
  const totals = weeks.map((w) => w.values.reduce((s, v) => s + v, 0));
  const t = ticks(0, Math.max(1, ...totals), 'count');
  const hi = t.at(-1)!;
  const band = (R - L) / Math.max(1, weeks.length);
  const barW = Math.min(24, band * 0.6);
  const yOf = (v: number) => BASE - (v / hi) * (BASE - TOP);
  const every = Math.ceil(weeks.length / 8);
  return (
    <div className="chart-wrap">
      <div className="legend" id={legendId}>
        {series.map((s, i) => (
          <span key={s}>
            <i className="sw" style={{ background: color(i) }} aria-hidden />
            {s}
          </span>
        ))}
      </div>
      <svg
        className="chart-svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={label}
        aria-describedby={legendId}
        tabIndex={0}
        onFocus={() => setAt((a) => a ?? weeks.length - 1)}
        onBlur={() => setAt(null)}
        onPointerLeave={() => setAt(null)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') setAt((a) => Math.min(weeks.length - 1, (a ?? -1) + 1));
          if (e.key === 'ArrowLeft') setAt((a) => Math.max(0, (a ?? weeks.length) - 1));
        }}
      >
        {t.map((v) => (
          <g key={v}>
            <line className="grid" x1={L} x2={R} y1={yOf(v)} y2={yOf(v)} />
            <text className="axis" x={L - 10} y={yOf(v) + 4} textAnchor="end">
              {v.toLocaleString('en-US')}
            </text>
          </g>
        ))}
        {weeks.map((w, i) => {
          const cx = L + band * i + band / 2;
          let acc = 0;
          const segs = order
            .map((s) => ({ s, v: w.values[s] ?? 0 }))
            .filter((x) => x.v > 0)
            .map((x) => {
              const y0 = yOf(acc);
              acc += x.v;
              return { ...x, y0, y1: yOf(acc) };
            });
          return (
            <g key={w.week} onPointerEnter={() => setAt(i)} className={at === i ? 'hovered' : undefined}>
              {/* The hit target is the whole column band. */}
              <rect x={L + band * i} y={TOP} width={band} height={BASE - TOP} fill="transparent" />
              {segs.map((g, k) => {
                const top = k === segs.length - 1;
                const h = Math.max(0, g.y0 - g.y1 - (top ? 0 : 2));
                return top ? (
                  <path
                    key={g.s}
                    d={`M${cx - barW / 2},${g.y0} V${g.y1 + Math.min(4, h)} Q${cx - barW / 2},${g.y1} ${cx - barW / 2 + 4},${g.y1} H${cx + barW / 2 - 4} Q${cx + barW / 2},${g.y1} ${cx + barW / 2},${g.y1 + Math.min(4, h)} V${g.y0} Z`}
                    fill={color(g.s)}
                  />
                ) : (
                  <rect key={g.s} x={cx - barW / 2} y={g.y1 + 2} width={barW} height={h} fill={color(g.s)} />
                );
              })}
              {i % every === 0 && (
                <text className="axis" x={cx} y={H - 14} textAnchor="middle">
                  {shortDate(w.week)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {at !== null && weeks[at] && (
        <Tip x={L + band * at + band / 2}>
          <b>{totals[at]!.toLocaleString('en-US')}</b>
          <span>Week of {shortDate(weeks[at]!.week)}</span>
          {series.map((s, i) => (
            <span key={s} className="tip-row">
              <i style={{ background: color(i) }} aria-hidden />
              {s}: {(weeks[at]!.values[i] ?? 0).toLocaleString('en-US')}
            </span>
          ))}
        </Tip>
      )}
    </div>
  );
}

/** Horizontal bars with the value at each tip (every value labeled). */
export function BarList({
  rows,
  unit,
  max,
}: {
  rows: { label: string; value: number | null; href?: string }[];
  unit: Unit;
  max?: number;
}) {
  const top = max ?? Math.max(1, ...rows.map((r) => r.value ?? 0));
  return (
    <div className="bars">
      {rows.map((r) => (
        <div key={r.label} className="bar-row">
          <span>{r.href ? <a href={r.href}>{r.label}</a> : r.label}</span>
          <div className="bar-track" aria-hidden>
            <div className="bar-fill" style={{ width: `${Math.max(0, ((r.value ?? 0) / top) * 100)}%` }} />
          </div>
          <span className="v">{formatValue(r.value, unit)}</span>
        </div>
      ))}
    </div>
  );
}
