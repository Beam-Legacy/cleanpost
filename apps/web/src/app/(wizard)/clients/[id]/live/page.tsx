import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { CircleCheck, CircleX, LoaderCircle } from 'lucide-react';
import { z } from 'zod';
import { now as clockNow } from '@cleanpost/clock';
import { policy } from '@cleanpost/domain';
import { LogoMark } from '@cleanpost/ui';
import { formatDate, formatWhen } from '@/lib/format';
import { billerChoices, firstSync, onboardingClient } from '@/lib/queries/onboarding';
import { requireActiveContext } from '@/lib/session';
import { Poll } from '../../new/wizard-client';

export const metadata: Metadata = { title: 'Client live' };

/** O-11 is for the first day; after that the route opens the client overview (CL-02). */
const SHOWN_FOR_MS = 24 * 60 * 60_000;

/**
 * O-11 Live: go-live confirmed, the first sync as it runs (counts only), and what to expect in the
 * first days. Refreshes itself until the first sync finishes.
 */
export default async function ClientLivePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const ctx = await requireActiveContext();
  if (!policy.authorize(ctx.actor, 'client.view', { clientId: id }).allowed) notFound();
  const c = await onboardingClient(ctx, id);
  if (!c) notFound();
  if (c.status === 'onboarding') redirect(`/clients/new/go-live?client=${id}`);
  const now = clockNow();
  if (!c.goLiveAt || now.getTime() - c.goLiveAt.getTime() > SHOWN_FOR_MS) redirect(`/clients/${id}`);
  const manual = c.connection?.adapterKey === 'manual';
  const sync = await firstSync(ctx, id, new Date(c.goLiveAt.getTime() - 60_000));
  const billers = await billerChoices(ctx, id);
  const primary = billers.find((b) => b.id === c.primaryBillerId)?.name;
  const pmName = c.connection?.pmName ?? 'the PM';
  const busy = !manual && (sync.status === 'waiting' || sync.status === 'running');

  return (
    <>
      <header className="wizard-head">
        <LogoMark />
        <b>{c.name}</b>
        <span className="chip chip-good">Live</span>
      </header>
      <main
        className="stack-lg"
        style={{ maxWidth: 760, margin: '0 auto', padding: 'var(--space-6) var(--space-4)' }}
      >
        <div className="empty" style={{ padding: 0 }}>
          <div className="glyph good">
            <CircleCheck aria-hidden />
          </div>
          <h1 className="display-m">{c.name} is live</h1>
          <p>
            Cleanpost started working claims {formatWhen(c.goLiveAt, now)}.
            {c.reviewUntil ? ` Billers review every claim until ${formatDate(c.reviewUntil)}.` : ''}
          </p>
        </div>
        <div className="card">
          <div className="card-body stack" aria-live="polite">
            {manual ? (
              <div className="row-between dense">
                <span>Claims start with the first charge file uploaded from {pmName}.</span>
              </div>
            ) : (
              <>
                <div className="row-between dense">
                  <span className="row" style={{ gap: 8 }}>
                    {sync.status === 'failed' ? (
                      <CircleX aria-hidden style={{ color: 'var(--danger)' }} />
                    ) : busy ? (
                      <LoaderCircle aria-hidden className="spin" />
                    ) : (
                      <CircleCheck aria-hidden style={{ color: 'var(--success)' }} />
                    )}
                    {sync.status === 'waiting'
                      ? 'First sync starting'
                      : sync.status === 'running'
                        ? `First sync with ${pmName} running`
                        : sync.status === 'failed'
                          ? 'First sync failed'
                          : 'First sync finished'}
                  </span>
                  {sync.finishedAt && !busy && (
                    <span className="subtle">{formatWhen(sync.finishedAt, now)}</span>
                  )}
                </div>
                {sync.status === 'failed' ? (
                  <div className="row-between dense">
                    <span>
                      {sync.errorDetail ?? `${pmName} did not answer.`} The client stays live; the next sync
                      tries again.
                    </span>
                    {c.connection && (
                      <Link className="btn btn-secondary btn-sm" href={`/integrations/${c.connection.id}`}>
                        Reconnect
                      </Link>
                    )}
                  </div>
                ) : (
                  <>
                    <div className="row-between dense">
                      <span>
                        {sync.encounters.toLocaleString('en-US')}{' '}
                        {sync.encounters === 1 ? 'encounter' : 'encounters'} and{' '}
                        {sync.patients.toLocaleString('en-US')} {sync.patients === 1 ? 'patient' : 'patients'}{' '}
                        pulled from {pmName}
                      </span>
                    </div>
                    <div className="row-between dense">
                      <span>
                        {sync.claims.toLocaleString('en-US')} {sync.claims === 1 ? 'claim' : 'claims'} built
                        {sync.waitingForReview
                          ? `, ${sync.waitingForReview.toLocaleString('en-US')} waiting for review${primary ? ` in ${primary}'s queue` : ''}`
                          : ''}
                      </span>
                    </div>
                  </>
                )}
                <Poll active={busy} ms={3000} forMs={180_000} />
              </>
            )}
          </div>
        </div>
        <div className="callout dense">
          <b>What to expect this week:</b> claims reach the queue as {pmName} charges come in; payments are
          checked as {pmName} posts them. An email went to your admins and this client&apos;s billers.
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <Link className="btn btn-primary" href={`/work?client=${id}`}>
            Open work queue
          </Link>
          <Link className="btn btn-secondary" href={`/clients/${id}`}>
            Client overview
          </Link>
          <Link className="btn btn-ghost" href="/clients/new/practice">
            Add another client
          </Link>
        </div>
      </main>
    </>
  );
}
