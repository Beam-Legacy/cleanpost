/**
 * Work queue vocabulary (docs/08-work-queue.md, W-01, W-06, W-07): item types and their chips,
 * resolution reasons per type, snooze presets and the due-chip rule. Pure functions.
 */

export type WorkItemType =
  | 'claim_review'
  | 'claim_blocked'
  | 'eligibility_issue'
  | 'card_review'
  | 'rejection'
  | 'no_response'
  | 'denial'
  | 'underpayment'
  | 'remit_unmatched'
  | 'out_of_balance'
  | 'mapping_needed'
  | 'posting_exception'
  | 'manual_task'
  | 'timely_filing_risk'
  | 'sync_failure'
  | 'system';

/** One line per type, as the list shows it. */
export const WORK_TYPE_LABEL: Record<WorkItemType, string> = {
  claim_review: 'Claim review',
  claim_blocked: 'Claim blocked',
  eligibility_issue: 'Eligibility',
  card_review: 'Card review',
  rejection: 'Rejection',
  no_response: 'No response',
  denial: 'Denial',
  underpayment: 'Underpayment',
  remit_unmatched: 'Unmatched payment',
  out_of_balance: 'Out of balance',
  mapping_needed: 'Code needs mapping',
  posting_exception: 'Posting difference',
  manual_task: 'Manual task',
  timely_filing_risk: 'Timely filing',
  sync_failure: 'Connection problem',
  system: 'System',
};

/** W-01 filter chips, in order. */
export const WORK_TYPE_GROUPS = [
  { key: 'review', label: 'Claim review', types: ['claim_review', 'claim_blocked'] },
  { key: 'rejections', label: 'Rejections', types: ['rejection'] },
  { key: 'denials', label: 'Denials', types: ['denial', 'underpayment'] },
  {
    key: 'posting',
    label: 'Posting',
    types: ['remit_unmatched', 'out_of_balance', 'mapping_needed', 'posting_exception'],
  },
  { key: 'eligibility', label: 'Eligibility', types: ['eligibility_issue', 'card_review'] },
  { key: 'manual', label: 'Manual tasks', types: ['manual_task'] },
  { key: 'other', label: 'Other', types: ['no_response', 'timely_filing_risk', 'sync_failure', 'system'] },
] as const satisfies readonly { key: string; label: string; types: readonly WorkItemType[] }[];

export type WorkTypeGroup = (typeof WORK_TYPE_GROUPS)[number]['key'];

export const typesOfGroup = (key: string): readonly WorkItemType[] | null =>
  WORK_TYPE_GROUPS.find((g) => g.key === key)?.types ?? null;

/** Items only admins see (docs/08: "4h (admin)"). */
export const ADMIN_ONLY_TYPES: readonly WorkItemType[] = ['sync_failure', 'system'];

const COMMON = ['Fixed in the PM', 'Duplicate item', 'Not ours to work'];

/** W-07 reasons per type; "Other" (always last) needs a note. Settings make these editable later. */
export const RESOLUTION_REASONS: Record<WorkItemType, readonly string[]> = {
  claim_review: ['Released in the PM', 'Voided in the PM', 'Duplicate item', 'Other'],
  claim_blocked: ['Fixed in the PM', 'Voided in the PM', 'Duplicate item', 'Other'],
  eligibility_issue: ['Coverage updated', 'Patient is self-pay', 'Verified with payer', 'Other'],
  card_review: ['Fields confirmed', 'Fields corrected', 'Other'],
  rejection: ['Resubmitted from the PM', 'Voided', 'Payer reprocessed', 'Other'],
  no_response: ['Payer confirmed receipt', 'Resubmitted', 'Other'],
  denial: ['Corrected and resubmitted', 'Written off', 'Appealed', 'Other'],
  underpayment: ['Accepted', 'Disputed', 'Other'],
  remit_unmatched: ['Linked by hand', 'Before go-live', 'Not ours', 'Other'],
  out_of_balance: ['Corrected 835 requested', 'Difference accepted', 'Other'],
  mapping_needed: ['Mapped', 'Other'],
  posting_exception: ['Corrected in the PM', 'Accepted as posted', 'Other'],
  manual_task: ['Done in the PM', 'No longer needed', 'Other'],
  timely_filing_risk: ['Submitted', 'Documented with payer', 'Escalated', 'Other'],
  sync_failure: ['Reconnected', 'Client paused', ...COMMON.slice(1), 'Other'],
  system: ['Retried', 'Handled by support', 'Other'],
};

export const reasonsFor = (type: string): readonly string[] =>
  RESOLUTION_REASONS[type as WorkItemType] ?? [...COMMON, 'Other'];

export const isWorkItemType = (t: string): t is WorkItemType => t in WORK_TYPE_LABEL;

/** W-07: a reason from the item's list; "Other" needs a note of its own. */
export function checkResolution(
  type: string,
  reason: string,
  note: string | null,
): { ok: true } | { ok: false; error: 'unknown_reason' | 'note_required' } {
  if (!reasonsFor(type).includes(reason)) return { ok: false, error: 'unknown_reason' };
  if (reason === 'Other' && !note?.trim()) return { ok: false, error: 'note_required' };
  return { ok: true };
}

const TZ = 'America/Los_Angeles';

/** The UTC instant of a wall-clock time in Pacific time on the given Pacific date. */
function pacific(date: { y: number; m: number; d: number }, hour: number): Date {
  // Try both offsets (PDT -7, PST -8) and keep the one that reads back as the wanted hour.
  for (const offset of [7, 8]) {
    const t = new Date(Date.UTC(date.y, date.m - 1, date.d, hour + offset));
    const h = Number(
      new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: TZ }).format(t),
    );
    if (h === hour) return t;
  }
  return new Date(Date.UTC(date.y, date.m - 1, date.d, hour + 8));
}

function pacificDate(now: Date, addDays = 0): { y: number; m: number; d: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
  }).formatToParts(new Date(now.getTime() + addDays * 86_400_000));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { y: Number(get('year')), m: Number(get('month')), d: Number(get('day')), weekday };
}

export interface SnoozePreset {
  key: 'later_today' | 'tomorrow' | 'next_week';
  label: string;
  until: Date;
}

/** W-06 presets: in 3 hours, tomorrow 8:00 am PT, next Monday 8:00 am PT. */
export function snoozePresets(now: Date): SnoozePreset[] {
  const tomorrow = pacificDate(now, 1);
  const today = pacificDate(now);
  const toMonday = (8 - today.weekday) % 7 || 7;
  return [
    { key: 'later_today', label: 'In 3 hours', until: new Date(now.getTime() + 3 * 3_600_000) },
    { key: 'tomorrow', label: 'Tomorrow 8:00 am', until: pacific(tomorrow, 8) },
    { key: 'next_week', label: 'Next Monday 8:00 am', until: pacific(pacificDate(now, toMonday), 8) },
  ];
}

/** Snoozing is limited to 30 days so nothing disappears for good. */
export function checkSnooze(now: Date, until: Date): { ok: true } | { ok: false; error: 'past' | 'too_far' } {
  if (until.getTime() <= now.getTime()) return { ok: false, error: 'past' };
  if (until.getTime() - now.getTime() > 30 * 86_400_000) return { ok: false, error: 'too_far' };
  return { ok: true };
}

/** W-01 due chip: amber within 4 hours of the SLA, red past it. */
export function dueState(dueAt: Date, now: Date): 'over' | 'soon' | 'ok' {
  const ms = dueAt.getTime() - now.getTime();
  if (ms < 0) return 'over';
  return ms <= 4 * 3_600_000 ? 'soon' : 'ok';
}

/** "Overdue 3 h", "2 h", "21 h", "Tomorrow", "2 d". */
export function dueLabel(dueAt: Date, now: Date): string {
  const ms = dueAt.getTime() - now.getTime();
  const hours = Math.round(Math.abs(ms) / 3_600_000);
  if (ms < 0)
    return hours < 1 ? 'Overdue' : hours < 48 ? `Overdue ${hours} h` : `Overdue ${Math.round(hours / 24)} d`;
  if (hours < 1) return `${Math.max(1, Math.round(ms / 60_000))} min`;
  if (hours < 24) return `${hours} h`;
  const due = pacificDate(dueAt);
  const tomorrow = pacificDate(now, 1);
  if (due.y === tomorrow.y && due.m === tomorrow.m && due.d === tomorrow.d) return 'Tomorrow';
  return `${Math.round(hours / 24)} d`;
}
