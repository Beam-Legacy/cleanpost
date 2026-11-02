/**
 * F-02 Posting worksheet (docs/07 "Posting"): what a person enters in a PM that Cleanpost cannot post
 * to or read from. One row per 835 line: the claim's control number and date of service, the code,
 * paid, each adjustment in the PM's own code, patient responsibility, and whether a secondary payer
 * should be billed. Denials are listed with no adjustment so the balance stays open. Codes only, no
 * procedure descriptions (CLAUDE.md rule 11); no patient names.
 */
import { formatCents } from '../money';
import type { ServiceLinePayment } from './types';
import { expectedPosting, type MappingLookup } from './verify';

export interface WorksheetClaim {
  patientControlNumber: string;
  dateOfService: string | null;
  /** A secondary coverage exists, so the patient's share may go to it first. */
  hasSecondary: boolean;
  lines: ServiceLinePayment[];
}

export interface WorksheetRow {
  patientControlNumber: string;
  dateOfService: string;
  code: string;
  paid: string;
  adjustments: string;
  patientResponsibility: string;
  note: string;
}

export interface Worksheet {
  rows: WorksheetRow[];
  /** Group-CARC pairs with no PM code yet: mapped first, or entered by hand with care. */
  unmapped: string[];
}

export function postingWorksheet(claims: readonly WorksheetClaim[], lookup: MappingLookup): Worksheet {
  const rows: WorksheetRow[] = [];
  const unmapped = new Set<string>();
  for (const c of claims) {
    for (const l of c.lines) {
      const want = expectedPosting(l, lookup);
      want.unmapped.forEach((p) => unmapped.add(p));
      const notes: string[] = [];
      if (want.deniedCents)
        notes.push(`Denied ${formatCents(want.deniedCents)}: leave open, do not write off`);
      if (want.unmapped.length) notes.push(`No PM code for ${want.unmapped.join(', ')}`);
      if (c.hasSecondary && want.patientRespCents > 0)
        notes.push('Bill the secondary payer before the patient');
      rows.push({
        patientControlNumber: c.patientControlNumber,
        dateOfService: l.serviceDate ?? c.dateOfService ?? '',
        code: [l.code, ...l.modifiers].join('-'),
        paid: formatCents(l.paidCents),
        adjustments: [...want.adjustments.entries()]
          .map(([code, cents]) => `${code} ${formatCents(cents)}`)
          .join('; '),
        patientResponsibility: formatCents(want.patientRespCents),
        note: notes.join('. '),
      });
    }
  }
  return { rows, unmapped: [...unmapped] };
}

const CSV_HEADER = [
  'Control number',
  'Date of service',
  'Code',
  'Paid',
  'Adjustments (PM codes)',
  'Patient responsibility',
  'Note',
];

/** CSV with a header row; every field quoted. */
export function worksheetCsv(w: Worksheet): string {
  const q = (v: string) => `"${v.replaceAll('"', '""')}"`;
  return [
    CSV_HEADER.map(q).join(','),
    ...w.rows.map((r) =>
      [
        r.patientControlNumber,
        r.dateOfService,
        r.code,
        r.paid,
        r.adjustments,
        r.patientResponsibility,
        r.note,
      ]
        .map(q)
        .join(','),
    ),
  ].join('\r\n');
}
