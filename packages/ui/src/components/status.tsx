import {
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock,
  RotateCcw,
  Send,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../cx';

type Tone = 'outline' | 'flight' | 'ready' | 'warn' | 'bad' | 'good';

/** Status vocabulary from docs/10-design-system.md: one style and icon per status, always with its word. */
export const STATUS = {
  Draft: ['outline', CircleDashed],
  Closed: ['outline', CircleDashed],
  Voided: ['outline', CircleDashed],
  Paused: ['outline', CircleDashed],
  Setup: ['outline', CircleDashed],
  Built: ['flight', Clock],
  Submitted: ['flight', Clock],
  Accepted: ['flight', Clock],
  Reversed: ['flight', Clock],
  Onboarding: ['flight', Clock],
  Testing: ['flight', Clock],
  Running: ['flight', Clock],
  Corrected: ['flight', RotateCcw],
  Ready: ['ready', Send],
  'Needs review': ['warn', TriangleAlert],
  Blocked: ['warn', TriangleAlert],
  'On hold': ['warn', TriangleAlert],
  'Partially paid': ['warn', TriangleAlert],
  'Due soon': ['warn', TriangleAlert],
  Degraded: ['warn', TriangleAlert],
  Rejected: ['bad', CircleX],
  Denied: ['bad', CircleX],
  Overdue: ['bad', CircleX],
  Failed: ['bad', CircleX],
  'Out of balance': ['bad', CircleX],
  Paid: ['good', CircleCheck],
  Posted: ['good', CircleCheck],
  Balanced: ['good', CircleCheck],
  Healthy: ['good', CircleCheck],
  Live: ['good', CircleCheck],
  Succeeded: ['good', CircleCheck],
} as const satisfies Record<string, readonly [Tone, LucideIcon]>;

export type Status = keyof typeof STATUS;

export function StatusChip({ status, className }: { status: Status; className?: string }) {
  const [tone, Icon] = STATUS[status];
  return (
    <span className={cx('chip', `chip-${tone}`, className)}>
      <Icon aria-hidden />
      {status}
    </span>
  );
}

const MODE_HELP = {
  A: 'Mode A: the PM sends claims and posts payments; Cleanpost checks them.',
  B: 'Mode B: Cleanpost sends claims through Stedi and posts payments into the PM.',
  C: 'Mode C: Cleanpost sends claims through Stedi; the PM keeps receiving and posting payments.',
} as const;

export function ModeBadge({ mode, long }: { mode: 'A' | 'B' | 'C'; long?: boolean }) {
  return (
    <span className="mode" title={MODE_HELP[mode]}>
      {long ? `Mode ${mode}` : mode}
      <span className="sr-only">{` — ${MODE_HELP[mode]}`}</span>
    </span>
  );
}

/** A code (CPT, ICD-10, CARC, ...) with its plain-language meaning as a tooltip and screen-reader text. */
export function CodeChip({ code, meaning, tone }: { code: string; meaning?: string; tone?: 'bad' | 'warn' }) {
  return (
    <span className={cx('codechip', tone)} title={meaning}>
      {code}
      {meaning && <span className="sr-only">{`: ${meaning}`}</span>}
    </span>
  );
}

export function DueChip({ children, state }: { children: ReactNode; state?: 'soon' | 'over' }) {
  return <span className={cx('due', state)}>{children}</span>;
}

export function PriorityMarker({ priority }: { priority: 1 | 2 | 3 | 4 }) {
  return (
    <span
      className={cx('prio', priority <= 3 && `p${priority}`)}
      role="img"
      aria-label={`Priority ${priority}`}
    />
  );
}

export function Dot({ tone, label }: { tone?: 'good' | 'warn' | 'bad'; label: string }) {
  return <span className={cx('dot', tone)} role="img" aria-label={label} />;
}

export function CountBadge({ count, strong, label }: { count: number; strong?: boolean; label?: string }) {
  return (
    <span className={cx('count-badge', strong && 'strong')} aria-label={label}>
      {count}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function Tag({ children, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className="tag" {...props}>
      {children}
    </span>
  );
}

export function Avatar({ name, size }: { name: string; size?: 'sm' }) {
  const initials = name
    .split(/\s+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return (
    <span className={cx('avatar', size)} role="img" aria-label={name}>
      {initials}
    </span>
  );
}
