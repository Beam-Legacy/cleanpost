'use client';
/**
 * W-22 Timely filing: get the claim to the payer before its filing limit. Shows how long is left and
 * where the limit comes from, what holds the claim (with a way to it), and the ways out: release
 * now, document proof that it was filed in time, or escalate to an admin.
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { work } from '@cleanpost/domain';
import { Button, Callout, Field, Input, Select, useToast } from '@cleanpost/ui';
import { formatDate } from '@/lib/format';
import type { WorkDetail } from '@/lib/queries/work';
import { approveAndRelease } from './actions';
import { escalateAction, filingProofAction } from './filing-actions';

export function TimelyFilingPanel({
  itemId,
  claim,
  filing: f,
  pmName,
  canRelease,
  canResolve,
  onDone,
}: {
  itemId: string;
  claim: NonNullable<WorkDetail['claim']>;
  filing: NonNullable<WorkDetail['filing']>;
  pmName: string;
  canRelease: boolean;
  canResolve: boolean;
  onDone: () => void;
}) {
  const [pending, start] = useTransition();
  const [file, setFile] = useState<File | null>(null);
  const [admin, setAdmin] = useState(f.admins[0]?.id ?? '');
  const toast = useToast();
  const router = useRouter();
  const urgency = work.filingUrgency(f.daysLeft);
  const tone = urgency === 'past' || urgency === 'red' ? 'var(--danger)' : 'var(--warning)';
  const payer = f.payerName ?? 'the payer';
  const releasable = !f.blocker && !f.correctionPending && ['ready', 'needs_review'].includes(claim.status);

  const run = (fn: () => Promise<{ ok: boolean; message: string }>, done = false) =>
    start(async () => {
      const res = await fn();
      toast({ message: res.message, ...(res.ok ? {} : { tone: 'bad' as const }) });
      if (res.ok && done) onDone();
      router.refresh();
    });

  return (
    <div className="stack">
      <div className="stack-sm">
        <span className="title-l" style={{ color: tone }}>
          {f.daysLeft < 0
            ? `Passed ${-f.daysLeft} ${f.daysLeft === -1 ? 'day' : 'days'} ago`
            : f.daysLeft === 0
              ? 'Due today'
              : `${f.daysLeft} ${f.daysLeft === 1 ? 'day' : 'days'} left`}
        </span>
        <span>
          {f.daysLeft < 0 ? `Was due to reach ${payer} by` : `Must reach ${payer} by`}{' '}
          {formatDate(f.deadline)}.
        </span>
        <span className="muted dense">
          Filing limit {f.limitDays} days from the date of service
          {f.limitSource === 'client_payer'
            ? `, set for this client and ${payer}.`
            : `: Cleanpost's default. Set ${payer}'s own limit in the client's payer settings.`}
        </span>
      </div>

      <div className="stack-sm">
        <span className="overline">What holds it</span>
        {f.blocker ? (
          <div className="row-between" style={{ gap: 8, alignItems: 'flex-start' }}>
            <span>
              <b>{work.WORK_TYPE_LABEL[f.blocker.type as work.WorkItemType] ?? f.blocker.type}:</b>{' '}
              {f.blocker.summary}
            </span>
            <Link className="btn btn-sm btn-primary" href={`/work?item=${f.blocker.id}`}>
              Fix blocker
            </Link>
          </div>
        ) : f.correctionPending ? (
          <span>
            Waiting for {pmName} to show a correction; the claim goes after the next sync that does.
          </span>
        ) : releasable ? (
          <div className="row-between" style={{ gap: 8 }}>
            <span>Nothing holds it: release it now.</span>
            {canRelease && claim.versionId && (
              <Button
                size="sm"
                variant="primary"
                disabled={pending}
                onClick={() =>
                  run(() => approveAndRelease({ itemId, claimId: claim.id, versionId: claim.versionId! }))
                }
              >
                Release now
              </Button>
            )}
          </div>
        ) : (
          <span>
            The claim is {claim.status.replaceAll('_', ' ')}. {pmName} sends it; this closes itself when{' '}
            {payer} accepts it.
          </span>
        )}
      </div>

      {canResolve && (
        <>
          <div className="stack-sm">
            <span className="overline">Proof of timely filing</span>
            <Field
              label="Clearinghouse report or payer letter"
              help="A PDF or a photo, up to 15 MB. Saving it resolves this item."
            >
              {(p) => (
                <Input
                  {...p}
                  type="file"
                  accept="application/pdf,image/jpeg,image/png,image/webp"
                  onChange={(e) => setFile(e.currentTarget.files?.[0] ?? null)}
                />
              )}
            </Field>
            <div>
              <Button
                size="sm"
                disabled={pending || !file}
                onClick={() =>
                  run(async () => {
                    const form = new FormData();
                    form.set('itemId', itemId);
                    form.set('file', file!);
                    return filingProofAction(form);
                  }, true)
                }
              >
                Save proof
              </Button>
            </div>
          </div>
          <div className="stack-sm">
            <span className="overline">Escalate</span>
            {f.admins.length ? (
              <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
                <Field label="Admin">
                  {(p) => (
                    <Select {...p} value={admin} onChange={(e) => setAdmin(e.target.value)}>
                      {f.admins.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Button
                  size="sm"
                  disabled={pending || !admin}
                  onClick={() => run(() => escalateAction(itemId, admin))}
                >
                  Escalate to admin
                </Button>
              </div>
            ) : (
              <span className="muted dense">No admin to escalate to.</span>
            )}
          </div>
        </>
      )}
      {f.daysLeft <= 3 && (
        <Callout>
          Admins get an email each day until this is resolved. This item cannot be snoozed past{' '}
          {formatDate(f.deadline)}.
        </Callout>
      )}
    </div>
  );
}
