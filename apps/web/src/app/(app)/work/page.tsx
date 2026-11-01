import type { Metadata } from 'next';
import { CircleCheck } from 'lucide-react';
import { EmptyState, KpiRow, KpiTile } from '@cleanpost/ui';
import { PageHead } from '@/components/page';
import { requireActiveContext } from '@/lib/session';

export const metadata: Metadata = { title: 'Work' };

/** W-01 Work queue. M0 shows the frame; items arrive with claims (M2). */
export default async function WorkPage() {
  const ctx = await requireActiveContext();
  return (
    <>
      <PageHead title="Work" subtitle={`0 items assigned to you · ${ctx.user.name}`} />
      <KpiRow label="Today">
        <KpiTile label="Due today" value="0" />
        <KpiTile label="Overdue" value="0" />
        <KpiTile label="Ready to release" value="0" />
        <KpiTile label="Released today" value="0" />
        <KpiTile label="Posted today" value="$0.00" />
        <KpiTile label="Released without review today" value="—" />
      </KpiRow>
      <EmptyState title="Nothing needs you right now" tone="good" icon={<CircleCheck />}>
        Claim reviews, rejections, denials and posting differences appear here once a client is connected.
      </EmptyState>
    </>
  );
}
