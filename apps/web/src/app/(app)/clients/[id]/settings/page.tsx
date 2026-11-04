import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { policy } from '@cleanpost/domain';
import { clientSettings } from '@/lib/queries/client-detail';
import { requireActiveContext } from '@/lib/session';
import { ClientSettingsForm } from './settings-form';

export const metadata: Metadata = { title: 'Client settings' };

/** CL-03 Client settings. Admins edit; billers see the settings read-only. Audited (CL-07). */
export default async function ClientSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireActiveContext();
  if (!policy.authorize(ctx.actor, 'client.view', { clientId: id }).allowed) notFound();
  const s = await clientSettings(ctx, id);
  if (!s) notFound();
  const canEdit = policy.authorize(ctx.actor, 'client.manage', { clientId: id }).allowed;
  return (
    <>
      {!canEdit && (
        <p className="muted dense" style={{ margin: 0 }}>
          Only admins change these settings.
        </p>
      )}
      <ClientSettingsForm clientId={id} initial={s} canEdit={canEdit} />
    </>
  );
}
