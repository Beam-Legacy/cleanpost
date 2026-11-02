/**
 * Claim edits before release (docs/08-work-queue.md "Correction capture", C-08, W-10):
 *
 * - `applyFix` applies one rule's `suggestedFix` to a claim payload.
 * - `diffPayload` lists every field that changed, one entry per corrections row.
 * - `checkEdit` refuses changes to fields an edit may not touch (patient, payer, providers, dates,
 *   charge amounts): those come from the PM in Mode A and are fixed there.
 *
 * Pure functions: codes and field paths only, never patient identifiers.
 */
import type { SuggestedFix } from '../rules/dsl';
import { lineMatches } from '../rules/dsl';
import type { Result } from '../state/machine';
import type { ClaimLinePayload, ClaimPayload } from './build';

export interface PayloadChange {
  /** "lines[0].modifiers", "lines[1]" (line removed), "priorAuthNumber", "diagnoses". */
  fieldPath: string;
  before: unknown;
  after: unknown;
  /** The PM's line, for write-back: the claim line's charge line. */
  chargeLineId?: string;
  /** One line for the C-08 footer and the timeline: "Line 1 modifier 25 added". */
  label: string;
}

export type FixError = 'needs_editor' | 'no_matching_line' | 'no_change' | 'would_empty_claim';

/** Fixes that need a person to choose something, so they open the editor instead. */
const EDITOR_ONLY = new Set<SuggestedFix['op']>(['reorderDiagnoses', 'setPayer', 'splitClaim']);

export const isOneClickFix = (fix: SuggestedFix) => !EDITOR_ONLY.has(fix.op);

function renumber(lines: ClaimLinePayload[]): ClaimLinePayload[] {
  return lines.map((l, i) => ({ ...l, lineNumber: i + 1 }));
}

const total = (lines: ClaimLinePayload[]) => lines.reduce((s, l) => s + l.chargeCents, 0);

/**
 * Applies a suggested fix. `lineNumbers` narrows it to the lines the finding named, so a rule that
 * matched line 1 does not also change line 3.
 */
export function applyFix(
  payload: ClaimPayload,
  fix: SuggestedFix,
  lineNumbers?: number[],
): Result<{ payload: ClaimPayload; changes: PayloadChange[] }, FixError> {
  if (EDITOR_ONLY.has(fix.op)) return { ok: false, error: 'needs_editor' };
  const inScope = (l: ClaimLinePayload) => !lineNumbers?.length || lineNumbers.includes(l.lineNumber);
  let next: ClaimPayload;
  switch (fix.op) {
    case 'addModifier':
    case 'removeModifier': {
      const targets = payload.lines.filter((l) => inScope(l) && lineMatches(l, fix.lineMatch));
      if (!targets.length) return { ok: false, error: 'no_matching_line' };
      const ids = new Set(targets.map((l) => l.chargeLineId));
      next = {
        ...payload,
        lines: payload.lines.map((l) => {
          if (!ids.has(l.chargeLineId)) return l;
          if (fix.op === 'addModifier')
            return l.modifiers.includes(fix.modifier) || l.modifiers.length >= 4
              ? l
              : { ...l, modifiers: [...l.modifiers, fix.modifier] };
          return { ...l, modifiers: l.modifiers.filter((m) => m !== fix.modifier) };
        }),
      };
      break;
    }
    case 'removeLine': {
      const keep = payload.lines.filter((l) => !(inScope(l) && lineMatches(l, fix.lineMatch)));
      if (keep.length === payload.lines.length) return { ok: false, error: 'no_matching_line' };
      if (!keep.length) return { ok: false, error: 'would_empty_claim' };
      const lines = renumber(keep);
      next = { ...payload, lines, totalChargeCents: total(lines) };
      break;
    }
    case 'setField': {
      next =
        fix.field === 'priorAuthNumber'
          ? { ...payload, priorAuthNumber: fix.value }
          : payload.facility
            ? { ...payload, facility: { ...payload.facility, placeOfService: fix.value ?? '' } }
            : payload;
      break;
    }
    default:
      return { ok: false, error: 'needs_editor' };
  }
  const changes = diffPayload(payload, next);
  if (!changes.length) return { ok: false, error: 'no_change' };
  return { ok: true, value: { payload: next, changes } };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function modifierLabel(n: number, before: string[], after: string[]): string {
  const added = after.filter((m) => !before.includes(m));
  const removed = before.filter((m) => !after.includes(m));
  const parts = [...added.map((m) => `modifier ${m} added`), ...removed.map((m) => `modifier ${m} removed`)];
  return `Line ${n} ${parts.length ? parts.join(', ') : 'modifiers reordered'}`;
}

/** Every changed field between two versions of the same claim, matched line by line. */
export function diffPayload(before: ClaimPayload, after: ClaimPayload): PayloadChange[] {
  const changes: PayloadChange[] = [];
  before.lines.forEach((b, i) => {
    const a = after.lines.find((l) => l.chargeLineId === b.chargeLineId);
    const n = b.lineNumber;
    const base = { chargeLineId: b.chargeLineId };
    if (!a) {
      changes.push({
        ...base,
        fieldPath: `lines[${i}]`,
        before: b.code,
        after: null,
        label: `Line ${n} (${b.code}) removed`,
      });
      return;
    }
    if (a.code !== b.code)
      changes.push({
        ...base,
        fieldPath: `lines[${i}].code`,
        before: b.code,
        after: a.code,
        label: `Line ${n} code ${b.code} changed to ${a.code}`,
      });
    if (!same(a.modifiers, b.modifiers))
      changes.push({
        ...base,
        fieldPath: `lines[${i}].modifiers`,
        before: b.modifiers,
        after: a.modifiers,
        label: modifierLabel(n, b.modifiers, a.modifiers),
      });
    if (a.units !== b.units)
      changes.push({
        ...base,
        fieldPath: `lines[${i}].units`,
        before: b.units,
        after: a.units,
        label: `Line ${n} units ${b.units} changed to ${a.units}`,
      });
    if (!same(a.dxPointers, b.dxPointers))
      changes.push({
        ...base,
        fieldPath: `lines[${i}].dxPointers`,
        before: b.dxPointers,
        after: a.dxPointers,
        label: `Line ${n} diagnosis pointers changed to ${a.dxPointers.join(', ') || 'none'}`,
      });
    if (a.chargeCents !== b.chargeCents)
      changes.push({
        ...base,
        fieldPath: `lines[${i}].chargeCents`,
        before: b.chargeCents,
        after: a.chargeCents,
        label: `Line ${n} charge changed`,
      });
  });
  for (const a of after.lines) {
    if (!before.lines.some((b) => b.chargeLineId === a.chargeLineId))
      changes.push({
        fieldPath: `lines[${a.lineNumber - 1}]`,
        before: null,
        after: a.code,
        chargeLineId: a.chargeLineId,
        label: `Line ${a.lineNumber} (${a.code}) added`,
      });
  }
  if (!same(before.diagnoses, after.diagnoses))
    changes.push({
      fieldPath: 'diagnoses',
      before: before.diagnoses,
      after: after.diagnoses,
      label: 'Diagnoses changed',
    });
  if (before.priorAuthNumber !== after.priorAuthNumber)
    changes.push({
      fieldPath: 'priorAuthNumber',
      before: before.priorAuthNumber,
      after: after.priorAuthNumber,
      label: after.priorAuthNumber ? 'Prior authorization number set' : 'Prior authorization number cleared',
    });
  if ((before.facility?.placeOfService ?? null) !== (after.facility?.placeOfService ?? null))
    changes.push({
      fieldPath: 'facility.placeOfService',
      before: before.facility?.placeOfService ?? null,
      after: after.facility?.placeOfService ?? null,
      label: `Place of service changed to ${after.facility?.placeOfService ?? 'none'}`,
    });
  if (before.referringNpi !== after.referringNpi)
    changes.push({
      fieldPath: 'referringNpi',
      before: before.referringNpi,
      after: after.referringNpi,
      label: 'Referring provider NPI changed',
    });
  return changes;
}

export type EditError = 'locked_field_changed' | 'line_added' | 'no_lines' | 'invalid_value';

/**
 * Accepts an edited payload only if it changes fields an edit may change. The rest (patient,
 * coverage, payer, providers, date of service, charge amounts, line identity) stays as built.
 */
export function checkEdit(before: ClaimPayload, after: ClaimPayload): Result<ClaimPayload, EditError> {
  const locked = (p: ClaimPayload) => ({
    frequencyCode: p.frequencyCode,
    patientId: p.patientId,
    coverageId: p.coverageId,
    payerId: p.payerId,
    payerName: p.payerName,
    billing: p.billing,
    rendering: p.rendering,
    facility: p.facility ? { locationId: p.facility.locationId, npi: p.facility.npi } : null,
    dateOfService: p.dateOfService,
  });
  if (!same(locked(before), locked(after))) return { ok: false, error: 'locked_field_changed' };
  if (!after.lines.length) return { ok: false, error: 'no_lines' };
  for (const a of after.lines) {
    const b = before.lines.find((l) => l.chargeLineId === a.chargeLineId);
    if (!b) return { ok: false, error: 'line_added' };
    if (a.chargeCents !== b.chargeCents || a.dateOfService !== b.dateOfService || a.ndc !== b.ndc)
      return { ok: false, error: 'locked_field_changed' };
    if (!/^[A-Z0-9]{5}$/.test(a.code)) return { ok: false, error: 'invalid_value' };
    if (a.modifiers.length > 4 || a.modifiers.some((m) => !/^[A-Z0-9]{2}$/.test(m)))
      return { ok: false, error: 'invalid_value' };
    if (!Number.isInteger(a.units) || a.units < 1 || a.units > 999)
      return { ok: false, error: 'invalid_value' };
    if (
      a.dxPointers.length > 4 ||
      a.dxPointers.some((p) => !Number.isInteger(p) || p < 1 || p > after.diagnoses.length)
    )
      return { ok: false, error: 'invalid_value' };
  }
  if (
    after.diagnoses.length > 12 ||
    after.diagnoses.some((d) => !/^[A-Z][0-9][0-9A-Z](\.?[0-9A-Z]{0,4})?$/.test(d.icd10))
  )
    return { ok: false, error: 'invalid_value' };
  const lines = renumber(after.lines);
  return {
    ok: true,
    value: {
      ...after,
      lines,
      diagnoses: after.diagnoses.map((d, i) => ({ ...d, sequence: i + 1 })),
      totalChargeCents: total(lines),
    },
  };
}
