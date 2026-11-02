/** Claim words shared by W-01, C-01 and C-02 to C-05: status chips and plain-language events. */
import type { Status } from '@cleanpost/ui';
import { claimStatus } from '@cleanpost/domain';
import { formatMoney } from './format';

export const CLAIM_STATUS: Record<string, Status> = {
  draft: 'Draft',
  built: 'Built',
  needs_review: 'Needs review',
  blocked: 'Blocked',
  on_hold: 'On hold',
  ready: 'Ready',
  submitted: 'Submitted',
  accepted: 'Accepted',
  rejected: 'Rejected',
  paid: 'Paid',
  partially_paid: 'Partially paid',
  denied: 'Denied',
  corrected: 'Corrected',
  closed: 'Closed',
  voided: 'Voided',
  reversed: 'Reversed',
};

export const FREQUENCY_LABEL: Record<string, string> = {
  '1': '1 · original',
  '7': '7 · replacement',
  '8': '8 · void',
};

const DECISION: Record<string, string> = {
  auto_release: 'releases without review',
  review: 'needs review',
  blocked: 'blocked',
};

export interface EventLike {
  type: string;
  actor: string;
  actorName: string | null;
  payload: Record<string, unknown>;
}

export type Tone = 'info' | 'good' | 'warn' | 'bad' | undefined;

/** One line per claim event (C-04), and its dot colour. Codes only, never patient details. */
export function describeEvent(e: EventLike, pmName: string): { title: string; tone: Tone } {
  const p = e.payload;
  switch (e.type) {
    case 'built': {
      if (p.reason === 'user_edit') {
        const n = Array.isArray(p.fields) ? p.fields.length : 0;
        return {
          title: `Edited: ${n === 1 ? '1 field' : `${n} fields`} changed (new version)`,
          tone: undefined,
        };
      }
      if (p.reason === 'pm_change')
        return { title: `New version: the charge changed in ${pmName}`, tone: undefined };
      return { title: `Built from the charge in ${pmName}`, tone: undefined };
    }
    case 'scrubbed': {
      const d = String(p.decision ?? '');
      return {
        title: `Scrubbed: confidence ${String(p.confidence ?? '—')}, ${DECISION[d] ?? d}`,
        tone: d === 'blocked' ? 'warn' : d === 'review' ? 'warn' : 'good',
      };
    }
    case 'approved':
      return { title: 'Approved for release', tone: 'good' };
    case 'unapproved':
      return { title: 'Approval undone; back in review', tone: undefined };
    case 'released':
      return {
        title:
          p.via === 'pm_schedule'
            ? `Released: ${pmName} bills it on its own schedule`
            : p.via === 'pm_outside_cleanpost'
              ? `Billed in ${pmName} outside Cleanpost`
              : `Released: approved in ${pmName}`,
        tone: 'good',
      };
    case 'ack_277ca':
      return {
        title:
          p.source === 'status_277'
            ? 'Accepted: the payer has it (found by a status check)'
            : p.source === '835'
              ? 'Accepted: the payer sent a payment for it'
              : '277CA: accepted by the payer',
        tone: 'info',
      };
    case 'rejected': {
      const reasons = Array.isArray(p.reasons) ? (p.reasons as string[]).join('; ') : '';
      return { title: `Rejected${reasons ? `: ${reasons}` : ''}`, tone: 'bad' };
    }
    case 'status_277': {
      if (typeof p.category !== 'string')
        return { title: 'Claim status update from the payer', tone: 'info' };
      const kind = claimStatus.statusKind(p.category);
      const code = `${p.category}${p.code ? `/${String(p.code)}` : ''}`;
      return {
        title: `Status check: ${claimStatus.categoryLabel(p.category).toLowerCase()} (${code})`,
        tone:
          kind === 'paid' || kind === 'received' || kind === 'pending'
            ? 'info'
            : kind === 'needs_info'
              ? 'warn'
              : kind === 'error'
                ? undefined
                : 'bad',
      };
    }
    case 'correction_requested':
      return { title: `Correction queued for ${pmName}`, tone: 'info' };
    case 'correction_pushed':
      return { title: `Correction written to ${pmName}`, tone: 'good' };
    case 'correction_manual':
      return { title: `Correction task opened: make the change in ${pmName}`, tone: 'warn' };
    case 'voided':
      return { title: `Voided${p.reason ? `: ${String(p.reason)}` : ''}`, tone: undefined };
    case 'held':
      return {
        title: `On hold: ${String(p.reason ?? '')}${p.until ? ` until ${String(p.until)}` : ''}`,
        tone: 'warn',
      };
    case 'hold_released':
      return { title: 'Hold released; checked again', tone: undefined };
    case 'note':
      return { title: `Note: ${String(p.text ?? '')}`, tone: undefined };
    case 'closed':
      return p.writeOffCents
        ? {
            title: `Written off ${formatMoney(Number(p.writeOffCents))}: ${String(p.reason ?? '').toLowerCase()}`,
            tone: undefined,
          }
        : { title: 'Closed', tone: undefined };
    case 'written_off':
      return {
        title: `Written off ${formatMoney(Number(p.writeOffCents))} (${formatMoney(Number(p.left))} still open): ${String(p.reason ?? '').toLowerCase()}`,
        tone: undefined,
      };
    case 'corrected':
      return {
        title: `Corrected claim built (frequency 7, replaces payer claim ${String(p.originalRef ?? '')})${p.fixed ? ' with the suggested fix' : ''}`,
        tone: 'info',
      };
    case 'denied':
      return { title: 'Denied by the payer', tone: 'bad' };
    case 'paid':
      return { title: 'Paid', tone: 'good' };
    case 'partially_paid':
      return { title: 'Partly paid', tone: 'warn' };
    default:
      return { title: e.type.replace(/_/g, ' '), tone: undefined };
  }
}

/** C-01 "Last event": short, from the event type alone. */
export const LAST_EVENT: Record<string, string> = {
  built: 'Built',
  scrubbed: 'Scrubbed',
  approved: 'Approved',
  unapproved: 'Approval undone',
  released: 'Released',
  ack_277ca: '277CA accepted',
  rejected: 'Rejected',
  status_277: 'Status update',
  correction_requested: 'Correction queued',
  correction_pushed: 'Correction written to the PM',
  correction_manual: 'Correction task opened',
  voided: 'Voided',
  closed: 'Closed',
  written_off: 'Written off in part',
  corrected: 'Correction built',
  denied: 'Denied',
  paid: 'Paid',
  partially_paid: 'Partly paid',
  note: 'Note added',
  held: 'On hold',
  hold_released: 'Hold released',
};

/** "Dana Reyes", "Automation (claim.scrub)" or "System" (docs/09 actor attribution). */
export function actorLabel(actor: string, name: string | null): string {
  if (actor.startsWith('user:')) return name ?? 'A user';
  if (actor.startsWith('automation:')) return `Automation (${actor.slice('automation:'.length)})`;
  if (actor.startsWith('operator:')) return 'Cleanpost support';
  return 'System';
}

/** Whole days between two dates of service ("Age" in C-01). */
export function daysSince(ymd: string, now = new Date()): number {
  return Math.max(0, Math.floor((now.getTime() - Date.parse(`${ymd}T00:00:00Z`)) / 86_400_000));
}
