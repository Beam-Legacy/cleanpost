/**
 * Canonical remittance to an X12 835 (005010X221A1): what payer-sim sends, and what tests read
 * back. Amounts from integer cents; the ISA envelope is fixed width; SE counts its segments.
 */
import type { Adjustment, Remittance835 } from '@cleanpost/domain/remit';

export interface Envelope {
  senderId: string;
  receiverId: string;
  /** Interchange control number (ISA13, GS06), 1 to 999999999. */
  control: number;
  /** Interchange date and time. */
  at: Date;
  test?: boolean;
}

/** 12000 -> "120.00", -215 -> "-2.15". */
export function fromCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

const pad = (s: string, n: number) => s.slice(0, n).padEnd(n, ' ');
const ymd = (iso: string) => iso.replaceAll('-', '');
/** X12 data may not contain the delimiters. */
const clean = (s: string) => s.replace(/[*~:^]/g, ' ');

function casSegments(adjustments: Adjustment[]): string[] {
  const byGroup = new Map<string, Adjustment[]>();
  for (const a of adjustments) byGroup.set(a.group, [...(byGroup.get(a.group) ?? []), a]);
  const out: string[] = [];
  for (const [group, list] of byGroup) {
    for (let i = 0; i < list.length; i += 6) {
      const triples = list
        .slice(i, i + 6)
        .map((a) =>
          [a.carc, fromCents(a.amountCents), a.quantity !== undefined ? String(a.quantity) : ''].join('*'),
        );
      out.push(['CAS', group, ...triples].join('*').replace(/\*+$/, ''));
    }
  }
  return out;
}

export function write835(r: Remittance835, env: Envelope): string {
  const d = env.at.toISOString();
  const date8 = d.slice(0, 10).replaceAll('-', '');
  const time4 = d.slice(11, 16).replace(':', '');
  const ctl = String(env.control).padStart(9, '0');
  const isa = [
    'ISA',
    '00',
    pad('', 10),
    '00',
    pad('', 10),
    'ZZ',
    pad(env.senderId, 15),
    'ZZ',
    pad(env.receiverId, 15),
    date8.slice(2),
    time4,
    '^',
    '00501',
    ctl,
    '0',
    env.test === false ? 'P' : 'T',
    ':',
  ].join('*');
  const body: string[] = [
    'ST*835*0001',
    [
      'BPR',
      r.payment.method === 'NON' ? 'H' : 'I',
      fromCents(r.payment.amountCents),
      'C',
      r.payment.method,
      ...(r.payment.method === 'NON'
        ? ['', '', '', '', '', '', '', '', '', '', '']
        : ['CCP', '01', '999999999', 'DA', '000000', '1000000000', '', '01', '999999999', 'DA', '000000']),
      ymd(r.payment.paymentDate),
    ].join('*'),
    `TRN*1*${clean(r.payment.traceNumber)}*1${clean(r.payer.id ?? '000000000')}`,
    `DTM*405*${ymd(r.payment.paymentDate)}`,
    `N1*PR*${clean(r.payer.name)}`,
    ...(r.payer.id ? [`REF*2U*${clean(r.payer.id)}`] : []),
    r.payee.npi ? `N1*PE*${clean(r.payee.name)}*XX*${r.payee.npi}` : `N1*PE*${clean(r.payee.name)}`,
    'LX*1',
  ];
  for (const c of r.claims) {
    body.push(
      [
        'CLP',
        clean(c.patientControlNumber),
        c.statusCode,
        fromCents(c.chargeCents),
        fromCents(c.paidCents),
        c.patientRespCents ? fromCents(c.patientRespCents) : '',
        '12',
        clean(c.payerClaimControlNumber ?? ''),
        '11',
        c.frequencyCode ?? '1',
      ].join('*'),
    );
    body.push(...casSegments(c.adjustments));
    if (c.patient) body.push(`NM1*QC*1*${clean(c.patient.lastName)}*${clean(c.patient.firstName)}`);
    if (c.crossoverPayerName) body.push(`NM1*TT*2*${clean(c.crossoverPayerName)}`);
    if (c.remarks.length) body.push(['MOA', '', '', ...c.remarks.slice(0, 5)].join('*'));
    if (c.serviceDateFrom) body.push(`DTM*232*${ymd(c.serviceDateFrom)}`);
    for (const l of c.lines) {
      body.push(
        [
          'SVC',
          ['HC', l.code, ...l.modifiers].join(':'),
          fromCents(l.chargeCents),
          fromCents(l.paidCents),
          '',
          String(l.units),
        ].join('*'),
      );
      if (l.serviceDate) body.push(`DTM*472*${ymd(l.serviceDate)}`);
      body.push(...casSegments(l.adjustments));
      if (l.lineControlNumber) body.push(`REF*6R*${clean(l.lineControlNumber)}`);
      if (l.allowedCents !== null) body.push(`AMT*B6*${fromCents(l.allowedCents)}`);
      for (const rarc of l.remarks) body.push(`LQ*HE*${rarc}`);
    }
  }
  if (r.providerAdjustments.length) {
    const pairs = r.providerAdjustments.flatMap((p) => [
      p.reference ? `${p.reasonCode}:${clean(p.reference)}` : p.reasonCode,
      fromCents(p.amountCents),
    ]);
    body.push(['PLB', r.payee.npi ?? '0000000000', `${d.slice(0, 4)}1231`, ...pairs].join('*'));
  }
  body.push(`SE*${body.length + 1}*0001`);
  const segs = [
    isa,
    `GS*HP*${clean(env.senderId)}*${clean(env.receiverId)}*${date8}*${time4}*${env.control}*X*005010X221A1`,
    ...body,
    `GE*1*${env.control}`,
    `IEA*1*${ctl}`,
  ];
  return `${segs.join('~\n')}~\n`;
}
