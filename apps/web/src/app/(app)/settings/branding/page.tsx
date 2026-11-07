import type { Metadata } from 'next';
import { formatValue, resolvePeriod } from '@/lib/report-display';
import { brandingPage } from '@/lib/queries/company';
import { getOverview, todayPacific } from '@/lib/queries/reports';
import { requireActiveContext } from '@/lib/session';
import { BrandingForm } from './branding-form';

export const metadata: Metadata = { title: 'Branding' };

/**
 * S-10 Branding (DEC-34): how client reports (F-01) look to the practices. The preview uses the first
 * client with claims and last month's figures; Open full preview renders F-01 for it.
 */
export default async function BrandingPage() {
  const ctx = await requireActiveContext();
  const b = await brandingPage(ctx);
  const { period, label } = resolvePeriod('last_month', todayPacific());
  const sample = b.sampleClient
    ? { ...b.sampleClient, label, kpis: (await getOverview(ctx, period, b.sampleClient.id)).kpis }
    : null;
  return (
    <BrandingForm
      companyName={b.companyName}
      branding={b.branding}
      logoUrl={
        b.branding.logo
          ? `/api/branding/logo?v=${encodeURIComponent(b.branding.logo.storageKey.slice(-8))}`
          : null
      }
      sample={
        sample && {
          id: sample.id,
          name: sample.name,
          label: sample.label,
          figures: [
            ['Collections', formatValue(sample.kpis.collectionsCents, 'cents')],
            ['First-pass', formatValue(sample.kpis.firstPass, 'percent')],
            ['Denial rate', formatValue(sample.kpis.denialRate, 'percent')],
            ['Days in A/R', sample.kpis.daysInAr === null ? '—' : String(Math.round(sample.kpis.daysInAr))],
          ],
        }
      }
    />
  );
}
