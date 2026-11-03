/**
 * RP-07: each KPI worked out with this report's own numbers ("$142,880 ÷ $5,953 = 24.0"), shared by
 * the overview, the client report and the practice report (F-01).
 */
import type { Kpis } from './queries/reports';
import { formatMoney } from './format';

const n = (v: number) => v.toLocaleString('en-US');
const pct = (v: number | null) => (v === null ? '—' : `${v.toFixed(1)}%`);

export function workingFor(k: Kpis, periodLabel: string) {
  const i = k.inputs;
  return {
    collections: k.collectionsCents ? `${formatMoney(k.collectionsCents)} on 835s paid ${periodLabel}` : null,
    firstPass: i.firstPass.total
      ? `${n(i.firstPass.accepted)} accepted ÷ ${n(i.firstPass.total)} first 277CAs = ${pct(k.firstPass)}`
      : null,
    denialRate: i.lines.total
      ? `${n(i.lines.denied)} denied ÷ ${n(i.lines.total)} lines = ${pct(k.denialRate)}`
      : null,
    daysInAr:
      i.charges90Cents && k.daysInAr !== null
        ? `${formatMoney(i.openArCents)} ÷ ${formatMoney(Math.round(i.charges90Cents / 90))} a day = ${k.daysInAr.toFixed(1)}`
        : null,
    releasedWithoutReview: i.released.total
      ? `${n(i.released.auto)} ÷ ${n(i.released.total)} released = ${pct(k.releasedWithoutReview)}`
      : null,
    linesWithoutTouch: i.era.total
      ? `${n(i.era.clean)} ÷ ${n(i.era.total)} lines = ${pct(k.linesWithoutTouch)}`
      : null,
    chargeToSubmission:
      k.chargeToSubmission !== null ? `Median ${k.chargeToSubmission.toFixed(1)} days` : null,
    remitToPosted: k.remitToPosted !== null ? `Median ${k.remitToPosted.toFixed(1)} days` : null,
  };
}
