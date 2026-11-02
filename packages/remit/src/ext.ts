/** A remittance as an adapter reads it from a PM, in the canonical shape (docs/05, docs/07). */
import type { ExtAdjustment, ExtRemittance } from '@cleanpost/adapters';
import type { remit } from '@cleanpost/domain';

const adj = (a: ExtAdjustment): remit.Adjustment => ({
  group: a.groupCode,
  carc: a.carc,
  amountCents: a.amountCents,
  ...(a.quantity !== undefined ? { quantity: a.quantity } : {}),
});

export function fromExtRemittance(e: ExtRemittance): remit.Remittance835 {
  return {
    payment: {
      method: e.paymentMethod,
      amountCents: e.paymentAmountCents,
      paymentDate: e.paymentDate,
      traceNumber: e.traceNumber,
    },
    payer: { name: e.payerName, id: null },
    payee: { name: '', npi: null },
    claims: e.claims.map((c) => ({
      patientControlNumber: c.patientControlNumber,
      statusCode: c.statusCode,
      chargeCents: c.chargeCents,
      paidCents: c.paidCents,
      patientRespCents: c.patientRespCents,
      payerClaimControlNumber: c.payerClaimControlNumber || null,
      frequencyCode: null,
      patient: null,
      serviceDateFrom: null,
      adjustments: c.adjustments.map(adj),
      remarks: [],
      lines: c.lines.map((l) => ({
        code: l.code,
        modifiers: l.modifiers,
        chargeCents: l.chargeCents,
        paidCents: l.paidCents,
        units: l.units,
        allowedCents: l.allowedCents ?? null,
        lineControlNumber: l.lineControlNumber ?? null,
        serviceDate: null,
        adjustments: l.adjustments.map(adj),
        remarks: l.remarks,
      })),
      crossoverPayerName: null,
    })),
    providerAdjustments: e.providerAdjustments.map((p) => ({
      reasonCode: p.reasonCode,
      reference: p.reference || null,
      amountCents: p.amountCents,
    })),
  };
}
