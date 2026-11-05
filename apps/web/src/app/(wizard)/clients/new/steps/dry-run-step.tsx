'use client';
/**
 * O-05 Dry run: the last 7 days pulled from the PM in the worker, read-only, nothing stored but
 * counts and names. The admin compares each sample encounter with the PM before going on.
 */
import { useState } from 'react';
import Link from 'next/link';
import { RefreshCw, TriangleAlert } from 'lucide-react';
import type { DryRunSummary } from '@cleanpost/domain';
import { Button, SkeletonRows } from '@cleanpost/ui';
import { formatMoney } from '@/lib/format';
import { confirmDryRunAction, runDryRunAction } from '../actions';
import { ContinueButton, Poll, StepError, StepFoot, useStepAction } from '../wizard-client';

export function DryRunStep({
  clientId,
  pmName,
  manual,
  running,
  summary,
  confirmed,
  unmatchedPayers,
  providersHref,
  back,
}: {
  clientId: string;
  pmName: string;
  manual: boolean;
  running: boolean;
  summary: DryRunSummary | null;
  confirmed: boolean;
  /** Payer names no payer's name or alias matches; fixed in the next step. */
  unmatchedPayers: number;
  providersHref: string;
  back: string;
}) {
  const act = useStepAction();
  const samples = summary?.samples ?? [];
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(confirmed ? samples.map((s) => s.encounterId) : []),
  );
  const all = samples.length > 0 && samples.every((s) => checked.has(s.encounterId));
  const toggle = (id: string) =>
    setChecked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (manual)
    return (
      <>
        <div className="card">
          <div className="card-body muted">
            {pmName} sends charges by file export, so there is nothing to pull yet. The first file you upload
            after going live is checked the same way.
          </div>
        </div>
        <StepFoot back={back}>
          <ContinueButton action={() => confirmDryRunAction(clientId, [])} />
        </StepFoot>
      </>
    );

  const problems = unmatchedPayers + (summary?.unknownNpis.length ?? 0);
  return (
    <>
      {running ? (
        <div className="card" aria-live="polite">
          <div className="card-body stack-sm">
            <span className="muted dense">
              Pulling the last 7 days from {pmName}. Nothing is sent or written.
            </span>
            <SkeletonRows rows={4} label="Pulling" />
            <Poll active={running} />
          </div>
        </div>
      ) : !summary ? (
        <div className="card">
          <div className="card-body stack-sm" style={{ alignItems: 'flex-start' }}>
            <span className="muted">Pull the last 7 days from {pmName} to check the data looks right.</span>
            <Button
              variant="primary"
              disabled={act.pending}
              onClick={() => act.run(() => runDryRunAction(clientId))}
            >
              {act.pending ? 'Starting…' : 'Run the dry run'}
            </Button>
            <StepError error={act.error} />
          </div>
        </div>
      ) : (
        <>
          <div className="kpis" role="group" aria-label="Dry run counts">
            <div className="kpi">
              <div className="kpi-label">Patients</div>
              <div className="kpi-value">{summary.patients.toLocaleString('en-US')}</div>
            </div>
            <div className="kpi">
              <div className="kpi-label">Encounters</div>
              <div className="kpi-value">{summary.encounters.toLocaleString('en-US')}</div>
            </div>
            <div className="kpi">
              <div className="kpi-label">Charge lines</div>
              <div className="kpi-value">{summary.lines.toLocaleString('en-US')}</div>
            </div>
            <div className="kpi">
              <div className="kpi-label">Payer names</div>
              <div className="kpi-value">{summary.payers.length}</div>
            </div>
            <div className="kpi">
              <div className="kpi-label">Problems found</div>
              <div className={`kpi-value${problems ? ' warn' : ''}`}>{problems}</div>
            </div>
          </div>
          {problems > 0 && (
            <div className="banner warn" role="status">
              <TriangleAlert aria-hidden />
              <span>
                {[
                  unmatchedPayers &&
                    `${unmatchedPayers === 1 ? '1 payer name is' : `${unmatchedPayers} payer names are`} not matched yet (next step)`,
                  summary.unknownNpis.length &&
                    `${summary.unknownNpis.length === 1 ? '1 provider NPI is' : `${summary.unknownNpis.length} provider NPIs are`} not set up (${summary.unknownNpis.join(', ')})`,
                ]
                  .filter(Boolean)
                  .join('; ')}
                .{' '}
                {summary.unknownNpis.length > 0 && (
                  <Link className="inline-link" href={providersHref}>
                    Add providers
                  </Link>
                )}
              </span>
            </div>
          )}
          <div className="card flush">
            <div className="card-head">
              <h2>Spot-check sample</h2>
              <span className="spacer" />
              <span className="subtle dense">
                {checked.size} of {samples.length} checked
              </span>
              <Button
                size="sm"
                disabled={act.pending}
                onClick={() => act.run(() => runDryRunAction(clientId))}
              >
                <RefreshCw aria-hidden />
                Run again
              </Button>
            </div>
            <div className="table-wrap">
              <table className="table nowrap" aria-label="Sample encounters">
                <thead>
                  <tr>
                    <th className="w-check">
                      <span className="sr-only">Checked</span>
                    </th>
                    <th>Encounter in {pmName}</th>
                    <th>Payer</th>
                    <th>Codes</th>
                    <th className="num">Charge</th>
                  </tr>
                </thead>
                <tbody>
                  {samples.map((s) => (
                    <tr key={s.encounterId}>
                      <td className="w-check">
                        <input
                          type="checkbox"
                          aria-label={`Checked ${s.encounterId} against ${pmName}`}
                          checked={checked.has(s.encounterId)}
                          onChange={() => toggle(s.encounterId)}
                        />
                      </td>
                      <td className="mono">{s.encounterId}</td>
                      <td>{s.payer ?? '—'}</td>
                      <td className="mono">{s.codes.join(', ')}</td>
                      <td className="num">{formatMoney(s.chargeCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="table-foot">
              <span className="subtle dense">
                Open each encounter in {pmName} by its number and check the codes and charge match. Patient
                details stay in the PM.
              </span>
            </div>
          </div>
          <StepError error={act.error} />
        </>
      )}
      <StepFoot back={back}>
        <ContinueButton
          disabled={running || !summary || !all}
          action={() => confirmDryRunAction(clientId, [...checked])}
        />
      </StepFoot>
    </>
  );
}
