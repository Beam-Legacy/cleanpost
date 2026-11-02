import { describe, expect, it } from 'vitest';
import {
  buildClaimPayload,
  filingDeadline,
  readyToBuild,
  samePayload,
  state,
  type ClaimContext,
  type EncounterForClaim,
} from '../src';

const encounter = (overrides: Partial<EncounterForClaim> = {}): EncounterForClaim => ({
  id: 'enc-1',
  dateOfService: '2026-10-27',
  status: 'ready',
  pmStatus: 'Review',
  updatedAt: new Date('2026-10-27T18:00:00Z'),
  renderingProvider: { id: 'prov-1', npi: '1932204415', taxonomy: '207Q00000X' },
  referringProviderNpi: null,
  location: { id: 'loc-1', placeOfService: '11', npi: null },
  priorAuthNumber: null,
  diagnoses: [
    { sequence: 2, icd10: 'I10' },
    { sequence: 1, icd10: 'M17.11' },
  ],
  lines: [
    {
      id: 'cl-2',
      lineNumber: 2,
      code: '20610',
      modifiers: ['RT'],
      units: 1,
      chargeCents: 14_500,
      diagnosisPointers: [1],
      ndc: null,
    },
    {
      id: 'cl-1',
      lineNumber: 1,
      code: '99213',
      modifiers: ['25'],
      units: 1,
      chargeCents: 13_500,
      diagnosisPointers: [1, 2],
      ndc: null,
    },
  ],
  ...overrides,
});

const ctx: ClaimContext = {
  patientId: 'pat-1',
  coverage: { id: 'cov-1', payerId: 'payer-aetna', payerName: 'Aetna' },
  client: { billingNpi: '1487726595', taxonomy: null },
  timelyFilingDays: 120,
};

describe('claim state machine', () => {
  it('follows the documented happy path for Mode A', () => {
    let s: state.ClaimState = 'draft';
    for (const [event, to] of [
      ['build', 'built'],
      ['scrub_review', 'needs_review'],
      ['approve', 'ready'],
      ['release', 'submitted'],
      ['accept', 'accepted'],
      ['pay', 'paid'],
      ['close', 'closed'],
    ] as const) {
      const r = state.nextClaimState(s, event);
      expect(r, `${s} -${event}->`).toEqual({ ok: true, value: to });
      s = to;
    }
  });

  it('sends edits back through scrub and refuses to edit a submitted claim', () => {
    expect(state.nextClaimState('ready', 'edit')).toEqual({ ok: true, value: 'built' });
    expect(state.nextClaimState('blocked', 'fix')).toEqual({ ok: true, value: 'built' });
    expect(state.nextClaimState('submitted', 'edit').ok).toBe(false);
    expect(state.nextClaimState('accepted', 'edit').ok).toBe(false);
    expect(state.nextClaimState('rejected', 'fix')).toEqual({ ok: true, value: 'built' });
    expect(state.nextClaimState('denied', 'correct')).toEqual({ ok: true, value: 'corrected' });
  });

  it('maps scrub decisions to events', () => {
    expect(state.scrubEvent('auto_release')).toBe('scrub_auto');
    expect(state.scrubEvent('review')).toBe('scrub_review');
    expect(state.scrubEvent('blocked')).toBe('scrub_block');
  });

  it('releases only with auto-release at threshold or a human approval', () => {
    const base = { state: 'ready' as const, threshold: 90, approvedBy: null };
    expect(state.canRelease({ ...base, decision: 'auto_release', confidence: 92 }).ok).toBe(true);
    expect(state.canRelease({ ...base, decision: 'auto_release', confidence: 85 })).toEqual({
      ok: false,
      error: 'needs_approval',
    });
    expect(state.canRelease({ ...base, decision: 'review', confidence: 70, approvedBy: 'user:u1' }).ok).toBe(
      true,
    );
    expect(
      state.canRelease({ ...base, decision: 'review', confidence: 70, approvedBy: 'automation:x' }).ok,
    ).toBe(false);
    expect(
      state.canRelease({ ...base, state: 'needs_review', decision: 'auto_release', confidence: 99 }),
    ).toEqual({
      ok: false,
      error: 'not_ready',
    });
  });
});

describe('claim builder', () => {
  it('builds a claim version by reference, lines renumbered and totals in cents', () => {
    const p = buildClaimPayload(encounter(), ctx);
    expect(p.lines.map((l) => [l.lineNumber, l.code, l.chargeLineId])).toEqual([
      [1, '99213', 'cl-1'],
      [2, '20610', 'cl-2'],
    ]);
    expect(p.diagnoses.map((d) => d.icd10)).toEqual(['M17.11', 'I10']);
    expect(p.totalChargeCents).toBe(28_000);
    expect(p).toMatchObject({
      patientId: 'pat-1',
      coverageId: 'cov-1',
      payerId: 'payer-aetna',
      frequencyCode: '1',
    });
    // No demographics or member IDs in the payload: they stay in their own columns.
    expect(JSON.stringify(p)).not.toMatch(/firstName|lastName|dob|memberId|address/i);
  });

  it('notices when a pulled change alters the claim, and only then', () => {
    const a = buildClaimPayload(encounter(), ctx);
    expect(samePayload(a, buildClaimPayload(encounter(), ctx))).toBe(true);
    const changed = encounter();
    changed.lines[1]!.modifiers = [];
    expect(samePayload(a, buildClaimPayload(changed, ctx))).toBe(false);
  });

  it('waits for charge entry to finish and skips what the PM already billed', () => {
    const now = new Date('2026-10-27T19:00:00Z');
    expect(readyToBuild(encounter(), now)).toEqual({ ok: true });
    expect(readyToBuild(encounter({ status: 'open', pmStatus: 'Draft' }), now)).toEqual({
      ok: false,
      reason: 'not_complete',
    });
    expect(
      readyToBuild(encounter({ status: 'open', pmStatus: 'Draft' }), new Date('2026-10-27T20:30:00Z')),
    ).toEqual({ ok: true });
    expect(readyToBuild(encounter({ pmStatus: 'Approved' }), now)).toEqual({
      ok: false,
      reason: 'billed_in_pm',
    });
    expect(readyToBuild(encounter({ status: 'void' }), now)).toEqual({ ok: false, reason: 'void' });
    expect(readyToBuild(encounter({ lines: [] }), now)).toEqual({ ok: false, reason: 'no_lines' });
  });

  it('computes the filing deadline from the date of service', () => {
    expect(filingDeadline('2026-10-27', 90)).toBe('2027-01-25');
    expect(filingDeadline('2026-12-31', 365)).toBe('2027-12-31');
  });
});
