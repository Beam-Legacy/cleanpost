import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Construction } from 'lucide-react';
import { EmptyState } from '@cleanpost/ui';
import { SETTINGS_SECTIONS } from '../sections';

export const metadata: Metadata = { title: 'Settings' };

/** Settings sections not built yet say so, with their view ID (docs/16-milestones.md). */
export default async function SettingsSectionPage({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  const s = SETTINGS_SECTIONS.find((x) => x.key === section);
  if (!s || s.built) notFound();
  return (
    <>
      <h2 className="title-m">{s.label}</h2>
      <EmptyState title="Not built yet" icon={<Construction />}>
        {s.label} ({s.view}) comes in a later step of the settings work.
      </EmptyState>
    </>
  );
}
