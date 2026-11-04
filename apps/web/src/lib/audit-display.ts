import { z } from 'zod';
import type { AuditFilters } from './queries/settings';

/**
 * S-13 Audit log wording: actions and record types in plain words, details from the metadata (which
 * never holds patient data, packages/db audit), and which rows to highlight.
 */

const VERB: Record<string, string> = {
  viewed: 'Viewed',
  view: 'Viewed',
  revealed: 'Revealed',
  created: 'Created',
  updated: 'Changed',
  saved: 'Saved',
  released: 'Released',
  approved: 'Approved',
  approval_undone: 'Undid approval',
  built: 'Built',
  scrubbed: 'Checked',
  edited: 'Edited',
  held: 'Held',
  hold_released: 'Released hold',
  voided: 'Voided',
  written_off: 'Wrote off',
  note_added: 'Added a note',
  correction_built: 'Built a correction',
  correction_pushed: 'Sent a correction to the PM',
  version_built: 'Built a version',
  status_checked: 'Checked status',
  checked: 'Checked',
  exported: 'Exported',
  downloaded: 'Downloaded',
  ingested: 'Received',
  verified: 'Verified',
  difference_accepted: 'Accepted a difference',
  payment_linked: 'Linked a payment',
  payment_set_aside: 'Set a payment aside',
  duplicate_ignored: 'Ignored a duplicate',
  resolved: 'Resolved',
  auto_resolved: 'Closed automatically',
  completed: 'Completed',
  escalated: 'Escalated',
  cancelled: 'Cancelled',
  company_chosen: 'Chose a company',
  clock_advanced: 'Moved the demo clock',
  sync_requested: 'Asked for a sync',
  sync_started: 'Started a sync',
  status_changed: 'Status changed',
  levels_updated: 'Changed levels',
  records_compared: 'Compared records',
  member_id_read: 'Read member ID',
  copied: 'Copied',
  invited: 'Invited',
  invite_resent: 'Resent invite',
  invite_revoked: 'Revoked invite',
  invite_accepted: 'Accepted invite',
  role_changed: 'Changed role',
  clients_changed: 'Changed client access',
  deactivated: 'Deactivated',
  reactivated: 'Reactivated',
  two_factor_reset: 'Reset two-factor',
  sessions_revoked: 'Signed out everywhere',
  threshold_changed: 'Changed release threshold',
  turned_off: 'Turned off',
  turned_on: 'Turned back on',
  tested: 'Tested',
  paused: 'Paused',
  resumed: 'Resumed',
  baseline_recorded: 'Recorded the baseline',
};

const RECORD: Record<string, string> = {
  patient: 'Patient',
  claim: 'Claim',
  claims_list: 'Claims list',
  coverage: 'Coverage',
  client: 'Client',
  connection: 'Connection',
  remittance: 'Payment',
  work_item: 'Work item',
  work_queue: 'Work queue',
  tenant: 'Company',
  membership: 'User',
  invitation: 'Invite',
  user: 'User',
  adjustment_mapping: 'Adjustment mapping',
  rule: 'Rule',
  encounter: 'Visit',
  manual_task: 'Manual task',
  write_off_request: 'Write-off request',
  eligibility_check: 'Eligibility check',
};

export function actionLabel(action: string): string {
  const verb = action.split('.').at(-1) ?? action;
  return VERB[verb] ?? verb.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());
}

export function recordLabel(entityType: string): string {
  return RECORD[entityType] ?? entityType.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());
}

/** Up to three metadata fields as "key: value" (metadata never carries patient data). */
export function detailsOf(metadata: unknown): string {
  if (!metadata || typeof metadata !== 'object') return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(metadata as Record<string, unknown>)) {
    if (parts.length === 3) break;
    if (v === null || v === undefined || typeof v === 'object') continue;
    // Record IDs are in the record column already.
    if (/id$/i.test(k) || (typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(v))) continue;
    const key = k.replace(/([A-Z])/g, ' $1').toLowerCase();
    parts.push(`${key}: ${String(v).slice(0, 60)}`);
  }
  return parts.join(' · ');
}

/** Rows a reviewer should not miss: exports and break-glass access. */
export const highlighted = (action: string) =>
  action.endsWith('.exported') || action.startsWith('break_glass') || action === 'audit.exported';

const DAYS = [1, 7, 30, 90] as const;

/** S-13 filters from the URL, each one checked. */
export function auditFilters(sp: Record<string, string | undefined>): AuditFilters {
  const who = sp.who === 'automation' || /^user:[0-9a-f-]{36}$/.test(sp.who ?? '') ? sp.who! : null;
  const days = DAYS.find((d) => String(d) === sp.days) ?? 7;
  return {
    who,
    action: sp.action && /^[a-z_.]{1,80}$/.test(sp.action) ? sp.action : null,
    record: sp.record && /^[a-z_]{1,60}$/.test(sp.record) ? sp.record : null,
    days,
    id: z.uuid().safeParse(sp.id?.trim()).success ? sp.id!.trim() : null,
    page: Math.max(1, Math.min(1000, Number.parseInt(sp.page ?? '1', 10) || 1)),
  };
}

/** The URL query for these filters (defaults left out). */
export const auditQuery = (f: AuditFilters, over: Partial<AuditFilters> = {}) => {
  const next = { ...f, ...over };
  const q = new URLSearchParams();
  if (next.who) q.set('who', next.who);
  if (next.action) q.set('action', next.action);
  if (next.record) q.set('record', next.record);
  if (next.days !== 7) q.set('days', String(next.days));
  if (next.id) q.set('id', next.id);
  if (next.page > 1) q.set('page', String(next.page));
  return q.toString();
};
