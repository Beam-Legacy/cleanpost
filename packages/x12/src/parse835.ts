/**
 * X12 835 (005010X221A1) parser into the canonical structure. Delimiters come from the ISA
 * envelope; amounts are converted to integer cents from their decimal text, never through floats.
 */
import type {
  Adjustment,
  ClaimPayment,
  GroupCode,
  ProviderAdjustment,
  Remittance835,
  ServiceLinePayment,
} from '@cleanpost/domain/remit';

export class X12Error extends Error {
  constructor(
    message: string,
    readonly segment?: number,
  ) {
    super(segment === undefined ? message : `${message} (segment ${segment})`);
    this.name = 'X12Error';
  }
}

/** "123.45" -> 12345, "-10" -> -1000, "0.5" -> 50. Throws on anything else. */
export function toCents(amount: string | undefined): number {
  if (amount === undefined || amount === '') return 0;
  const m = /^(-)?(\d*)(?:\.(\d{0,2}))?$/.exec(amount.trim());
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) throw new X12Error(`not an amount: ${amount}`);
  const cents = Number(m[2] || '0') * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  return m[1] ? -cents : cents;
}

const date = (d: string | undefined) =>
  d && /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null;

const GROUPS = new Set(['CO', 'PR', 'OA', 'PI', 'CR']);

interface Delimiters {
  element: string;
  segment: string;
  component: string;
}

function delimiters(raw: string): Delimiters {
  const start = raw.indexOf('ISA');
  if (start < 0 || raw.length < start + 106) throw new X12Error('no ISA envelope');
  const isa = raw.slice(start);
  const element = isa[3]!;
  // ISA is fixed width: 16 elements, the component separator is ISA16, then the segment terminator.
  const fields = isa.split(element);
  const component = fields[16]?.[0] ?? ':';
  const segment = fields[16]?.[1] ?? '~';
  return { element, segment, component };
}

/** CAS*group*reason*amount*qty (up to six reason/amount/qty triples). */
function cas(el: string[], at: number): Adjustment[] {
  const group = el[1] as GroupCode;
  if (!GROUPS.has(group)) throw new X12Error(`unknown adjustment group ${el[1]}`, at);
  const out: Adjustment[] = [];
  for (let i = 2; i + 1 < el.length; i += 3) {
    if (!el[i]) continue;
    const quantity = el[i + 2] ? Number(el[i + 2]) : undefined;
    out.push({
      group,
      carc: el[i]!,
      amountCents: toCents(el[i + 1]),
      ...(quantity !== undefined ? { quantity } : {}),
    });
  }
  return out;
}

export function parse835(raw: string): Remittance835 {
  const d = delimiters(raw);
  const segments = raw
    .split(d.segment)
    .map((s) => s.replace(/^\s+/, ''))
    .filter(Boolean)
    .map((s) => s.split(d.element));
  if (!segments.some((s) => s[0] === 'ST' && s[1] === '835')) throw new X12Error('not an 835 (ST01)');

  const out: Remittance835 = {
    payment: { method: 'NON', amountCents: 0, paymentDate: '', traceNumber: '' },
    payer: { name: '', id: null },
    payee: { name: '', npi: null },
    claims: [],
    providerAdjustments: [],
  };
  let claim: ClaimPayment | null = null;
  let line: ServiceLinePayment | null = null;
  let loop: 'header' | 'payer' | 'payee' | 'claim' = 'header';

  segments.forEach((el, i) => {
    const id = el[0];
    switch (id) {
      case 'BPR': {
        const method = el[4];
        out.payment.amountCents = toCents(el[2]);
        out.payment.method = method === 'ACH' || method === 'CHK' ? method : 'NON';
        out.payment.paymentDate = date(el[16]) ?? '';
        break;
      }
      case 'TRN':
        out.payment.traceNumber = el[2] ?? '';
        if (el[3]) out.payer.id = el[3].replace(/^1/, '') || el[3];
        break;
      case 'DTM':
        if (el[1] === '405' && !out.payment.paymentDate) out.payment.paymentDate = date(el[2]) ?? '';
        if (line && (el[1] === '472' || el[1] === '150')) line.serviceDate = date(el[2]);
        else if (claim && el[1] === '232') claim.serviceDateFrom = date(el[2]);
        break;
      case 'N1':
        if (el[1] === 'PR') {
          loop = 'payer';
          out.payer.name = el[2] ?? '';
        } else if (el[1] === 'PE') {
          loop = 'payee';
          out.payee.name = el[2] ?? '';
          if (el[3] === 'XX') out.payee.npi = el[4] ?? null;
        }
        break;
      case 'REF':
        if (line && el[1] === '6R') line.lineControlNumber = el[2] ?? null;
        else if (loop === 'payer' && el[1] === '2U' && !out.payer.id) out.payer.id = el[2] ?? null;
        break;
      case 'CLP': {
        loop = 'claim';
        line = null;
        claim = {
          patientControlNumber: el[1] ?? '',
          statusCode: el[2] ?? '',
          chargeCents: toCents(el[3]),
          paidCents: toCents(el[4]),
          patientRespCents: toCents(el[5]),
          payerClaimControlNumber: el[7] || null,
          frequencyCode: el[9] || null,
          patient: null,
          serviceDateFrom: null,
          adjustments: [],
          remarks: [],
          lines: [],
          crossoverPayerName: null,
        };
        out.claims.push(claim);
        break;
      }
      case 'NM1':
        if (claim && el[1] === 'QC') claim.patient = { lastName: el[3] ?? '', firstName: el[4] ?? '' };
        if (claim && el[1] === 'TT') claim.crossoverPayerName = el[3] ?? null;
        break;
      case 'MOA':
      case 'MIA':
        if (claim) for (const r of el.slice(3)) if (/^[A-Z]{1,2}\d{1,3}$/.test(r)) claim.remarks.push(r);
        break;
      case 'CAS':
        if (line) line.adjustments.push(...cas(el, i));
        else if (claim) claim.adjustments.push(...cas(el, i));
        else throw new X12Error('CAS outside a claim', i);
        break;
      case 'SVC': {
        if (!claim) throw new X12Error('SVC outside a claim', i);
        const proc = (el[1] ?? '').split(d.component);
        line = {
          code: proc[1] ?? '',
          modifiers: proc.slice(2).filter(Boolean),
          chargeCents: toCents(el[2]),
          paidCents: toCents(el[3]),
          units: el[5] ? Number(el[5]) : 1,
          allowedCents: null,
          lineControlNumber: null,
          serviceDate: null,
          adjustments: [],
          remarks: [],
        };
        claim.lines.push(line);
        break;
      }
      case 'AMT':
        if (line && el[1] === 'B6') line.allowedCents = toCents(el[2]);
        break;
      case 'LQ':
        if (line && el[1] === 'HE' && el[2]) line.remarks.push(el[2]);
        break;
      case 'PLB':
        // PLB*provider*date*reason:ref*amount (up to six pairs).
        for (let k = 3; k + 1 < el.length; k += 2) {
          if (!el[k]) continue;
          const [reasonCode, reference] = el[k]!.split(d.component);
          const adj: ProviderAdjustment = {
            reasonCode: reasonCode ?? '',
            reference: reference || null,
            amountCents: toCents(el[k + 1]),
          };
          out.providerAdjustments.push(adj);
        }
        claim = null;
        line = null;
        break;
      case 'SE':
        claim = null;
        line = null;
        break;
      default:
        break;
    }
  });
  if (!out.payment.traceNumber) throw new X12Error('no TRN trace number');
  if (!out.payment.paymentDate) throw new X12Error('no payment date (BPR16)');
  return out;
}
