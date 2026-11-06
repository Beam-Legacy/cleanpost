import { describe, expect, it } from 'vitest';
import { work } from '../src';

describe('work queue vocabulary', () => {
  it('puts every item type in exactly one chip', () => {
    const grouped = work.WORK_TYPE_GROUPS.flatMap((g) => g.types);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped].sort()).toEqual(Object.keys(work.WORK_TYPE_LABEL).sort());
  });

  it('needs a known reason, and a note for Other (W-07)', () => {
    expect(work.checkResolution('claim_review', 'Released in the PM', null)).toEqual({ ok: true });
    expect(work.checkResolution('claim_review', 'Made up', null)).toEqual({
      ok: false,
      error: 'unknown_reason',
    });
    expect(work.checkResolution('denial', 'Other', ' ')).toEqual({ ok: false, error: 'note_required' });
    expect(work.checkResolution('denial', 'Other', 'Payer called back')).toEqual({ ok: true });
    for (const reasons of Object.values(work.RESOLUTION_REASONS)) expect(reasons.at(-1)).toBe('Other');
  });

  it('offers snooze presets in Pacific time (W-06)', () => {
    // Friday Oct 30, 2026, 3:00 pm PDT.
    const now = new Date('2026-10-30T22:00:00Z');
    const [later, tomorrow, monday] = work.snoozePresets(now);
    expect(later!.until.toISOString()).toBe('2026-10-31T01:00:00.000Z');
    expect(tomorrow!.until.toISOString()).toBe('2026-10-31T15:00:00.000Z'); // Sat 8:00 am PDT
    expect(monday!.until.toISOString()).toBe('2026-11-02T16:00:00.000Z'); // Mon 8:00 am PST
  });

  it('limits snoozes to the next 30 days', () => {
    const now = new Date('2026-10-30T22:00:00Z');
    expect(work.checkSnooze(now, new Date('2026-10-30T21:00:00Z'))).toEqual({ ok: false, error: 'past' });
    expect(work.checkSnooze(now, new Date('2026-12-30T21:00:00Z'))).toEqual({ ok: false, error: 'too_far' });
    expect(work.checkSnooze(now, new Date('2026-11-01T21:00:00Z'))).toEqual({ ok: true });
  });

  it('shows due chips amber within 4 hours and red when overdue', () => {
    const now = new Date('2026-10-30T22:00:00Z');
    const at = (h: number) => new Date(now.getTime() + h * 3_600_000);
    expect(work.dueState(at(-1), now)).toBe('over');
    expect(work.dueState(at(3), now)).toBe('soon');
    expect(work.dueState(at(21), now)).toBe('ok');
    expect(work.dueLabel(at(-3), now)).toBe('Overdue 3 h');
    expect(work.dueLabel(at(2), now)).toBe('2 h');
    expect(work.dueLabel(at(48), now)).toBe('2 d');
  });
});

describe('W-22 timely filing', () => {
  it('lets a timely-filing item snooze up to its deadline day (Pacific), not past it', () => {
    // 11 pm Pacific on Nov 8 is still Nov 8.
    expect(work.snoozeBeforeDeadline(new Date('2026-11-09T07:00:00Z'), '2026-11-08')).toBe(true);
    expect(work.snoozeBeforeDeadline(new Date('2026-11-09T09:00:00Z'), '2026-11-08')).toBe(false);
  });

  it('counts days to the deadline and how urgent that is', () => {
    expect(work.daysUntil('2026-11-08', '2026-11-06')).toBe(2);
    expect(work.daysUntil('2026-11-01', '2026-11-06')).toBe(-5);
    expect([20, 14, 4, 3, 0, -1].map(work.filingUrgency)).toEqual([
      'ok',
      'amber',
      'amber',
      'red',
      'red',
      'past',
    ]);
  });
});
