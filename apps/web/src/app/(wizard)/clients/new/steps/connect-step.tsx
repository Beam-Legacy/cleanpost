'use client';
/**
 * O-04 Connect: make the connection and run the adapter's health check (in the worker). For a demo
 * PM, Connect also creates the practice in the mock PM with synthetic patients and charges. A manual
 * PM has nothing to connect. Continue needs a passing test.
 */
import { Ban, CircleCheck, CircleX, ListChecks, PlugZap } from 'lucide-react';
import { Button, Skeleton } from '@cleanpost/ui';
import { formatWhen } from '@/lib/format';
import { connectAction, continueConnectAction, retestAction } from '../actions';
import { ContinueButton, Poll, StepError, StepFoot, useStepAction } from '../wizard-client';

export interface TestRow {
  label: string;
  state: 'ok' | 'manual' | 'unavailable' | 'failed';
  note: string;
}

const ICON = {
  ok: <CircleCheck aria-hidden style={{ color: 'var(--success)' }} />,
  manual: <ListChecks aria-hidden style={{ color: 'var(--warning)' }} />,
  unavailable: <Ban aria-hidden style={{ color: 'var(--ink-subtle)' }} />,
  failed: <CircleX aria-hidden style={{ color: 'var(--danger)' }} />,
};

export function ConnectStep({
  clientId,
  pmName,
  demo,
  manual,
  connected,
  testing,
  test,
  rows,
  back,
}: {
  clientId: string;
  pmName: string;
  /** A demo PM: Connect makes the practice in the mock PM. */
  demo: boolean;
  manual: boolean;
  connected: boolean;
  testing: boolean;
  test: { ok: boolean; checkedAt: string; failure: string | null } | null;
  rows: TestRow[];
  back: string;
}) {
  const act = useStepAction();
  return (
    <>
      <div className="grid-2" style={{ alignItems: 'start' }}>
        <div className="card">
          <div className="card-body stack">
            {manual ? (
              <p className="muted" style={{ margin: 0 }}>
                {pmName} has no integration yet, so there is nothing to sign in to. Charges come by file
                export and Cleanpost prepares the rest as tasks for billers.
              </p>
            ) : demo ? (
              <>
                <p style={{ margin: 0 }}>
                  In this demo, {pmName} is Cleanpost&apos;s mock PM running {pmName}&apos;s limits. Connect
                  makes the practice there with this client&apos;s providers and locations, synthetic patients
                  and a month of charges, then tests the connection.
                </p>
                <p className="muted dense" style={{ margin: 0 }}>
                  With a real {pmName} account you would create a dedicated API user and paste its key here.
                  Credentials go to the secrets manager, never the database or logs.
                </p>
              </>
            ) : null}
            <div className="row" style={{ gap: 8 }}>
              <Button
                variant={connected ? 'secondary' : 'primary'}
                disabled={act.pending || testing}
                onClick={() => act.run(() => (connected ? retestAction(clientId) : connectAction(clientId)))}
              >
                <PlugZap aria-hidden />
                {act.pending
                  ? connected
                    ? 'Starting test…'
                    : 'Connecting…'
                  : connected
                    ? manual
                      ? 'Check again'
                      : 'Test again'
                    : manual
                      ? 'Set up manual connection'
                      : 'Connect and test'}
              </Button>
            </div>
            <StepError error={act.error} />
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h2>Connection test</h2>
            <span className="spacer" />
            {test && !testing && (
              <span className="subtle dense">{formatWhen(new Date(test.checkedAt), new Date())}</span>
            )}
          </div>
          <div className="card-body stack-sm" aria-live="polite">
            {testing ? (
              <>
                <span className="muted dense">Testing {pmName}…</span>
                <Skeleton width="100%" height={18} />
                <Skeleton width="80%" height={18} />
                <Skeleton width="90%" height={18} />
                <Poll active={testing} />
              </>
            ) : !test ? (
              <span className="muted dense">Not tested yet.</span>
            ) : (
              <>
                {rows.map((r) => (
                  <div key={r.label} className="row-between dense">
                    <span className="row" style={{ gap: 8 }}>
                      {ICON[r.state]}
                      {r.label}
                    </span>
                    <span className="subtle">{r.note}</span>
                  </div>
                ))}
                <div className="stack-sm" style={{ marginTop: 8, gap: 2 }}>
                  <b>{test.ok ? 'Connected' : 'Not connected'}</b>
                  <span className="muted dense">
                    {test.ok
                      ? manual
                        ? 'Nothing to test for a PM without an integration.'
                        : `Everything ${pmName} allows is working.`
                      : (test.failure ?? `${pmName} did not answer. Test again in a moment.`)}
                  </span>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      <StepFoot back={back}>
        <ContinueButton disabled={!test?.ok || testing} action={() => continueConnectAction(clientId)} />
      </StepFoot>
    </>
  );
}
