/**
 * Claim builder (docs/04-modes.md step 3): turns a canonical encounter into a claim version. Pure.
 *
 * The payload is the canonical 837P shape *by reference*: patient, coverage and payer are IDs, and
 * names, addresses and member IDs stay in their own (encrypted) columns. Mode A does not send this
 * payload anywhere (the PM's clearinghouse sends the claim); Modes B and C render the 837 from it at
 * release and keep that rendered file as the snapshot.
 */
import type { Cents } from '../money';

export interface EncounterForClaim {
  id: string;
  dateOfService: string;
  status: 'open' | 'ready' | 'claimed' | 'void';
  pmStatus: string | null;
  updatedAt: Date;
  renderingProvider: { id: string; npi: string; taxonomy: string | null } | null;
  referringProviderNpi: string | null;
  location: { id: string; placeOfService: string; npi: string | null } | null;
  priorAuthNumber: string | null;
  diagnoses: { sequence: number; icd10: string }[];
  lines: {
    id: string;
    lineNumber: number;
    code: string;
    modifiers: string[];
    units: number;
    chargeCents: Cents;
    diagnosisPointers: number[];
    ndc: string | null;
  }[];
}

export interface ClaimContext {
  patientId: string;
  /** The primary coverage, if any. */
  coverage: { id: string; payerId: string | null; payerName: string } | null;
  client: { billingNpi: string | null; taxonomy: string | null };
  /** Timely filing days for this client and payer (client_payer_settings), else the default. */
  timelyFilingDays: number;
}

export interface ClaimLinePayload {
  lineNumber: number;
  chargeLineId: string;
  code: string;
  modifiers: string[];
  units: number;
  chargeCents: Cents;
  dxPointers: number[];
  ndc: string | null;
  dateOfService: string;
}

export interface ClaimPayload {
  frequencyCode: '1' | '7' | '8';
  patientId: string;
  coverageId: string | null;
  payerId: string | null;
  payerName: string | null;
  billing: { npi: string | null; taxonomy: string | null };
  rendering: { providerId: string; npi: string; taxonomy: string | null } | null;
  referringNpi: string | null;
  facility: { locationId: string; placeOfService: string; npi: string | null } | null;
  dateOfService: string;
  priorAuthNumber: string | null;
  diagnoses: { sequence: number; icd10: string }[];
  lines: ClaimLinePayload[];
  totalChargeCents: Cents;
}

/** PM statuses meaning the PM has already sent the claim itself (Tebra Approved; generic billed). */
const PM_BILLED = new Set(['Approved', 'billed']);

export type BuildSkipReason = 'void' | 'claimed' | 'billed_in_pm' | 'not_complete' | 'no_lines';

/**
 * Is the encounter's charge entry complete (docs/04-modes.md step 3)? Ready in the PM, or no
 * changes for the quiet period. Encounters the PM already sent (billed before Cleanpost saw them)
 * are not rebuilt; they are tracked from the PM's claim status instead.
 */
export function readyToBuild(
  e: Pick<EncounterForClaim, 'status' | 'pmStatus' | 'updatedAt' | 'lines'>,
  now: Date,
  quietPeriodMinutes = 120,
): { ok: true } | { ok: false; reason: BuildSkipReason } {
  if (e.status === 'void') return { ok: false, reason: 'void' };
  if (e.status === 'claimed') return { ok: false, reason: 'claimed' };
  if (e.pmStatus && PM_BILLED.has(e.pmStatus)) return { ok: false, reason: 'billed_in_pm' };
  if (e.lines.length === 0) return { ok: false, reason: 'no_lines' };
  if (e.status === 'ready') return { ok: true };
  const quiet = now.getTime() - e.updatedAt.getTime() >= quietPeriodMinutes * 60_000;
  return quiet ? { ok: true } : { ok: false, reason: 'not_complete' };
}

export function buildClaimPayload(
  e: EncounterForClaim,
  ctx: ClaimContext,
  frequencyCode: ClaimPayload['frequencyCode'] = '1',
): ClaimPayload {
  const lines = [...e.lines]
    .sort((a, b) => a.lineNumber - b.lineNumber)
    .map((l, i) => ({
      lineNumber: i + 1,
      chargeLineId: l.id,
      code: l.code,
      modifiers: [...l.modifiers],
      units: l.units,
      chargeCents: l.chargeCents,
      dxPointers: [...l.diagnosisPointers],
      ndc: l.ndc,
      dateOfService: e.dateOfService,
    }));
  return {
    frequencyCode,
    patientId: ctx.patientId,
    coverageId: ctx.coverage?.id ?? null,
    payerId: ctx.coverage?.payerId ?? null,
    payerName: ctx.coverage?.payerName ?? null,
    billing: { npi: ctx.client.billingNpi, taxonomy: ctx.client.taxonomy },
    rendering: e.renderingProvider
      ? {
          providerId: e.renderingProvider.id,
          npi: e.renderingProvider.npi,
          taxonomy: e.renderingProvider.taxonomy,
        }
      : null,
    referringNpi: e.referringProviderNpi,
    facility: e.location
      ? { locationId: e.location.id, placeOfService: e.location.placeOfService, npi: e.location.npi }
      : null,
    dateOfService: e.dateOfService,
    priorAuthNumber: e.priorAuthNumber,
    diagnoses: [...e.diagnoses].sort((a, b) => a.sequence - b.sequence),
    lines,
    totalChargeCents: lines.reduce((s, l) => s + l.chargeCents, 0),
  };
}

/** Key-order-independent comparison, to decide whether a pulled change needs a new version. */
export function samePayload(a: ClaimPayload, b: ClaimPayload): boolean {
  const norm = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(norm)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v as object)
              .sort()
              .map((k) => [k, norm((v as Record<string, unknown>)[k])]),
          )
        : v;
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

/** Filing deadline: date of service plus the client-payer's timely filing days (docs/03). */
export function filingDeadline(dateOfService: string, days: number): string {
  const d = new Date(`${dateOfService}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
