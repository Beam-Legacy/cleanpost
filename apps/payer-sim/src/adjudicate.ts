/**
 * Adjudication (docs/12-testing.md "Payer simulator"): what the payer decides for an accepted claim,
 * as an 835 claim payment that balances by construction (every line's charge - paid equals its CAS).
 *
 * - Allowed amount: a percent of charges per payer, varied per code; the rest is CO-45.
 * - Patient share from the member file: copay PR-3 on the office visit, deductible PR-1 and
 *   coinsurance PR-2 on the rest; preventive care and vaccines carry no share on commercial plans;
 *   Medicaid carries none.
 * - Denials from the claim itself, as a payer's edits would find them: coverage not active on the
 *   date of service CO-27, member unknown CO-31, filed too late CO-29, exact duplicate CO-18, an
 *   office visit with a procedure or preventive visit and no modifier 25 CO-4, an NCCI bundled pair
 *   CO-97, no prior authorization CO-197.
 */
import type { remit } from '@cleanpost/domain';
import { CODE_GROUPS, NCCI_BYPASS_MODIFIERS } from '@cleanpost/domain/rules';
import type { SubmittedClaim } from './ack';
import { hash, type PayerProfile } from './payers';

export interface NcciPair {
  column1: string;
  column2: string;
  modifierIndicator: string;
}

export interface MemberFile {
  status: string;
  planBegin: string | null;
  planEnd: string | null;
  copayCents: number | null;
  deductibleRemainingCents: number | null;
  coinsurancePercent: number | null;
}

export interface AdjudicationInput {
  claim: SubmittedClaim;
  payer: PayerProfile;
  /** null when the member ID is not on the payer's file. */
  member: MemberFile | null;
  /** When the payer received the claim (the simulated clock). */
  receivedAt: Date;
  /** The same member, date and services were already processed under another claim. */
  duplicate: boolean;
  ncci: readonly NcciPair[];
}

export interface Adjudication {
  payment: remit.ClaimPayment;
  /** Deductible this claim used, to take off the member's remaining deductible. */
  deductibleUsedCents: number;
}

const inGroup = (group: string, code: string) => CODE_GROUPS[group]?.includes(code) ?? false;
const isOfficeVisit = (code: string) => inGroup('em_office', code);
const noCostShare = (code: string) =>
  inGroup('em_preventive', code) || inGroup('vaccine_admin', code) || /^90[67]\d\d$/.test(code);

const ymd8 = (iso: string) => iso.replaceAll('-', '');
const days = (fromIso: string, to: Date) =>
  Math.floor((to.getTime() - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);

/** The payer's claim number (CLP07): stable per submission, 14 digits. */
export function payerClaimNumber(payerId: string, pcn: string): string {
  return `${String(hash(`${payerId}:${pcn}`)).padStart(10, '0')}${String(hash(pcn) % 10_000).padStart(4, '0')}`;
}

type LineClaim = SubmittedClaim['lines'][number];

/** Why the payer denies a line, if it does: [CARC, RARC]. */
function lineDenial(
  c: SubmittedClaim,
  l: LineClaim,
  input: AdjudicationInput,
): [string, string | null] | null {
  if (isOfficeVisit(l.code) && !l.modifiers.includes('25')) {
    const withProcedure = c.lines.some(
      (o) => o !== l && (inGroup('minor_procedures', o.code) || inGroup('em_preventive', o.code)),
    );
    if (withProcedure) return ['4', 'N822'];
  }
  for (const o of c.lines) {
    if (o === l) continue;
    const edit = input.ncci.find((e) => e.column1 === o.code && e.column2 === l.code);
    if (!edit || edit.modifierIndicator === '9') continue;
    const bypassed =
      edit.modifierIndicator === '1' && l.modifiers.some((m) => NCCI_BYPASS_MODIFIERS.includes(m));
    if (!bypassed) return ['97', 'M15'];
  }
  if (input.payer.authRequired.includes(l.code) && !c.priorAuthNumber) return ['197', null];
  return null;
}

/** Why the payer denies the whole claim, if it does. */
function claimDenial(input: AdjudicationInput): [string, string | null] | null {
  const { claim: c, member, payer } = input;
  if (!member) return ['31', null];
  const dos = ymd8(c.dateOfService);
  const outsidePlan =
    (member.planBegin && dos < member.planBegin) || (member.planEnd && dos > member.planEnd);
  if (member.status !== 'active' || outsidePlan) return ['27', 'N30'];
  if (days(c.dateOfService, input.receivedAt) > payer.timelyFilingDays) return ['29', null];
  if (input.duplicate) return ['18', null];
  return null;
}

/** Allowed amount for a line: the payer's percent, varied by up to 5 points per code. */
export function allowedFor(payer: PayerProfile, code: string, chargeCents: number): number {
  const pct = payer.allowedPercent + ((hash(`${payer.id}:${code}`) % 11) - 5);
  return Math.min(chargeCents, Math.round((chargeCents * pct) / 100));
}

export function adjudicate(input: AdjudicationInput): Adjudication {
  const { claim: c, payer, member } = input;
  const denied = claimDenial(input);
  let copayLeft = payer.kind === 'commercial' ? (member?.copayCents ?? 0) : 0;
  let deductibleLeft = payer.kind === 'medicaid' ? 0 : (member?.deductibleRemainingCents ?? 0);
  const coinsurance =
    payer.kind === 'medicaid' ? 0 : payer.kind === 'medicare' ? 20 : (member?.coinsurancePercent ?? 0);
  let deductibleUsedCents = 0;

  const lines: remit.ServiceLinePayment[] = c.lines.map((l) => {
    const base = {
      code: l.code,
      modifiers: l.modifiers,
      chargeCents: l.chargeCents,
      units: l.units,
      lineControlNumber: l.lineControlNumber ?? null,
      serviceDate: c.dateOfService,
    };
    const deny = denied ?? lineDenial(c, l, input);
    if (deny) {
      return {
        ...base,
        paidCents: 0,
        allowedCents: 0,
        adjustments: [{ group: 'CO', carc: deny[0], amountCents: l.chargeCents }],
        remarks: deny[1] ? [deny[1]] : [],
      };
    }
    const allowed = allowedFor(payer, l.code, l.chargeCents);
    const adjustments: remit.Adjustment[] = [];
    if (l.chargeCents > allowed)
      adjustments.push({ group: 'CO', carc: '45', amountCents: l.chargeCents - allowed });
    let left = allowed;
    if (!(payer.kind === 'commercial' && noCostShare(l.code)) && payer.kind !== 'medicaid') {
      if (isOfficeVisit(l.code) && copayLeft > 0) {
        const copay = Math.min(copayLeft, left);
        copayLeft -= copay;
        left -= copay;
        if (copay) adjustments.push({ group: 'PR', carc: '3', amountCents: copay });
      } else {
        const ded = Math.min(deductibleLeft, left);
        deductibleLeft -= ded;
        deductibleUsedCents += ded;
        left -= ded;
        if (ded) adjustments.push({ group: 'PR', carc: '1', amountCents: ded });
        const coins = Math.round((left * coinsurance) / 100);
        left -= coins;
        if (coins) adjustments.push({ group: 'PR', carc: '2', amountCents: coins });
      }
    }
    return { ...base, paidCents: left, allowedCents: allowed, adjustments, remarks: [] };
  });

  const paidCents = lines.reduce((s, l) => s + l.paidCents, 0);
  const patientRespCents = lines.reduce(
    (s, l) => s + l.adjustments.filter((a) => a.group === 'PR').reduce((t, a) => t + a.amountCents, 0),
    0,
  );
  const allDenied = lines.every((l) => l.allowedCents === 0);
  return {
    payment: {
      patientControlNumber: c.patientControlNumber,
      statusCode: allDenied ? '4' : '1',
      chargeCents: lines.reduce((s, l) => s + l.chargeCents, 0),
      paidCents,
      patientRespCents,
      payerClaimControlNumber: payerClaimNumber(payer.id, c.patientControlNumber),
      frequencyCode: c.frequencyCode ?? '1',
      patient: null,
      serviceDateFrom: c.dateOfService,
      adjustments: [],
      remarks: [],
      lines,
      crossoverPayerName: null,
    },
    deductibleUsedCents,
  };
}
