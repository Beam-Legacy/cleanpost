import type { ReactNode } from 'react';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { policy } from '@cleanpost/domain';
import { Banner, ModeBadge, StatusChip } from '@cleanpost/ui';
import { ConnectionDot } from '@/components/connection-status';
import { formatDate, formatWhen } from '@/lib/format';
import { clientHeader } from '@/lib/queries/client-detail';
import { resumeHref } from '@/lib/queries/onboarding';
import { requireActiveContext } from '@/lib/session';
import { PauseClient, ResumeClient } from './client-actions';
import { ClientTabs } from './client-tabs';

const STATUS = { live: 'Live', onboarding: 'Onboarding', paused: 'Paused', offboarded: 'Closed' } as const;

/** CL-02 to CL-07 frame: who the client is, how it connects, its status and pause, and the tabs. */
export default async function ClientLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const ctx = await requireActiveContext();
  const c = await clientHeader(ctx, id);
  if (!c) notFound();
  const isAdmin = policy.authorize(ctx.actor, 'client.manage', { clientId: id }).allowed;
  // A client still onboarding opens its wizard where it was left (O-01 to O-10).
  if (c.status === 'onboarding' && isAdmin) {
    const resume = await resumeHref(ctx, id);
    if (resume) redirect(resume);
  }
  const now = new Date();

  return (
    <>
      <div className="page-head">
        <div className="stack-sm" style={{ gap: 4 }}>
          <span className="dense">
            <Link href="/clients">Clients</Link>
          </span>
          <h1>{c.name}</h1>
          <span className="row dense muted" style={{ gap: 8 }}>
            <StatusChip status={STATUS[c.status]} />
            <ModeBadge mode={c.mode} />
            <span>{c.pmName}</span>
            <span aria-hidden>·</span>
            {c.connection ? (
              <span className="row dense" style={{ gap: 6 }}>
                <ConnectionDot status={c.connection.status} />
                {c.connection.lastSuccessAt && (
                  <span>last sync {formatWhen(c.connection.lastSuccessAt, now)}</span>
                )}
              </span>
            ) : (
              <span>No connection</span>
            )}
            {c.goLiveAt && (
              <>
                <span aria-hidden>·</span>
                <span>Live since {formatDate(c.goLiveAt.toISOString().slice(0, 10))}</span>
              </>
            )}
          </span>
        </div>
        <div className="actions">
          {isAdmin && c.status === 'live' && (
            <PauseClient clientId={c.id} clientName={c.name} pmName={c.pmName} />
          )}
          <Link className="btn btn-secondary btn-sm" href={`/reports/clients/${c.id}`}>
            Client report
          </Link>
        </div>
      </div>
      {c.status === 'paused' && (
        <Banner tone="warn" action={isAdmin ? <ResumeClient clientId={c.id} /> : undefined}>
          Paused
          {c.pause
            ? ` since ${formatDate(c.pause.pausedAt.slice(0, 10))}: ${c.pause.reason.toLowerCase()}`
            : ''}
          . Syncing continues; claims wait to be released until it resumes
          {c.pause?.resumeOn ? ` (planned for ${formatDate(c.pause.resumeOn)})` : ''}.
        </Banner>
      )}
      {c.connection && (c.connection.status === 'failed' || c.connection.status === 'degraded') && (
        <Banner
          tone={c.connection.status === 'failed' ? 'bad' : 'warn'}
          action={
            isAdmin ? (
              <Link className="btn btn-secondary btn-sm" href={`/integrations/${c.connection.id}`}>
                Reconnect
              </Link>
            ) : undefined
          }
        >
          The connection to {c.pmName} is {c.connection.status === 'failed' ? 'failing' : 'degraded'}.
        </Banner>
      )}
      <ClientTabs clientId={c.id} />
      {children}
    </>
  );
}
