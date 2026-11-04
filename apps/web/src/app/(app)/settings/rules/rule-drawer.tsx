'use client';
/**
 * S-06 Rule detail: the rule in plain words (generated from its JSON), where it applies, what it did
 * in the last 30 days, its history, and the switches: a built-in rule turns off for the company
 * (G-11 confirm) or one client; a company rule turns off for the company. Test on last 30 days runs
 * the rule against recent claims as billed.
 */
import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, ConfirmDialog, Drawer, useToast } from '@cleanpost/ui';
import { switchRule, testRule, type RuleTestResult } from './actions';

export interface DrawerRule {
  id: string;
  name: string;
  kindLabel: string;
  scopeLabel: string;
  sourceLabel: string;
  builtIn: boolean;
  on: boolean;
  offFor: { id: string; name: string }[];
  version: number;
  hits: number;
  overridden: number | null;
  when: string;
  then: string[];
  history: { at: string; who: string; what: string }[];
}

export function RuleDrawer({
  rule: r,
  clients,
}: {
  rule: DrawerRule;
  clients: { id: string; name: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [client, setClient] = useState('');
  const [test, setTest] = useState<RuleTestResult | null>(null);
  const [pending, start] = useTransition();
  const toast = useToast();
  const router = useRouter();

  const flip = (on: boolean, clientId: string | null) =>
    start(async () => {
      const res = await switchRule({ ruleId: r.id, clientId, on });
      toast({ message: res.message, ...(res.ok ? {} : { tone: 'bad' as const }) });
      if (res.ok) {
        setClient('');
        router.refresh();
      }
    });
  const runTest = () =>
    start(async () => {
      const res = await testRule(r.id);
      setTest(res);
      if (!res.ok) toast({ message: res.message, tone: 'bad' });
    });
  const choices = clients.filter((c) => !r.offFor.some((o) => o.id === c.id));

  return (
    <>
      <Drawer
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) setTest(null);
        }}
        trigger={
          <button type="button" className="link-button" style={{ textAlign: 'left' }}>
            {r.name}
          </button>
        }
        title={r.name}
        description={`${r.kindLabel} · ${r.scopeLabel} · ${r.sourceLabel} · version ${r.version}`}
        wide
      >
        <div className="stack">
          <section className="stack-sm" aria-label="When">
            <span className="overline">When</span>
            <p style={{ margin: 0 }}>{r.when}.</p>
          </section>
          <section className="stack-sm" aria-label="Then">
            <span className="overline">Then</span>
            {r.then.map((t) => (
              <p key={t} style={{ margin: 0 }}>
                {t}
              </p>
            ))}
          </section>
          <dl className="kv dense">
            <dt>Hits, 30 days</dt>
            <dd className="num">{r.hits}</dd>
            <dt>Overridden</dt>
            <dd>{r.overridden === null ? '—' : `${r.overridden}%`}</dd>
            <dt>Status</dt>
            <dd>
              {r.on ? 'On' : 'Off for the company'}
              {r.offFor.length > 0 && ` · off for ${r.offFor.map((o) => o.name).join(', ')}`}
            </dd>
          </dl>

          <section className="stack-sm" aria-label="Test">
            <div>
              <Button size="sm" onClick={runTest} disabled={pending}>
                Test on last 30 days
              </Button>
            </div>
            {test?.ok && (
              <div className="stack-sm" role="status">
                <p style={{ margin: 0 }}>{test.message}</p>
                {test.samples && test.samples.length > 0 && (
                  <p className="dense" style={{ margin: 0 }}>
                    Examples:{' '}
                    {test.samples.map((id, i) => (
                      <span key={id}>
                        {i > 0 && ', '}
                        <Link className="code inline-link" href={`/claims/${id}`}>
                          {id.slice(-8)}
                        </Link>
                      </span>
                    ))}
                  </p>
                )}
                <p className="muted dense" style={{ margin: 0 }}>
                  Checked against each claim as billed. Rules on the patient&apos;s sex or age are not tested
                  here.
                </p>
              </div>
            )}
          </section>

          <section className="stack-sm" aria-label="On and off">
            <span className="overline">On and off</span>
            {r.builtIn && (
              <p className="muted dense" style={{ margin: 0 }}>
                Built-in rules are not edited. Turn one off for the company or for a client instead.
              </p>
            )}
            <div className="row dense" style={{ gap: 8 }}>
              {r.on ? (
                <Button
                  size="sm"
                  variant="danger"
                  disabled={pending}
                  onClick={() => (r.builtIn ? setConfirm(true) : flip(false, null))}
                >
                  Turn off for the company
                </Button>
              ) : (
                <Button size="sm" variant="primary" disabled={pending} onClick={() => flip(true, null)}>
                  Turn back on
                </Button>
              )}
            </div>
            {r.builtIn && r.on && (
              <div className="row dense" style={{ gap: 8, alignItems: 'flex-end' }}>
                <div className="field">
                  <label htmlFor={`off-client-${r.id}`}>Turn off for one client</label>
                  <select
                    id={`off-client-${r.id}`}
                    className="select"
                    value={client}
                    onChange={(e) => setClient(e.target.value)}
                  >
                    <option value="">Choose a client</option>
                    {choices.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <Button size="sm" disabled={pending || !client} onClick={() => flip(false, client)}>
                  Turn off for this client
                </Button>
              </div>
            )}
            {r.offFor.map((o) => (
              <div key={o.id} className="row dense" style={{ gap: 8 }}>
                <span>Off for {o.name}</span>
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => flip(true, o.id)}>
                  Turn back on<span className="sr-only"> for {o.name}</span>
                </Button>
              </div>
            ))}
          </section>

          <section className="stack-sm" aria-label="History">
            <span className="overline">History</span>
            {r.history.length === 0 ? (
              <p className="muted dense" style={{ margin: 0 }}>
                {r.builtIn ? 'Built in, unchanged here.' : 'No changes yet.'}
              </p>
            ) : (
              <ul className="dense" style={{ margin: 0, paddingLeft: 18 }}>
                {r.history.map((h, i) => (
                  <li key={i}>
                    {h.what} · {h.who} · {h.at}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </Drawer>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Turn off "${r.name}"?`}
        description={
          <p style={{ margin: 0 }}>
            It is a built-in rule: claims for every client stop being checked for it from the next scrub. You
            can turn it back on at any time.
          </p>
        }
        confirmLabel="Turn off for the company"
        danger
        onConfirm={() => {
          setConfirm(false);
          flip(false, null);
        }}
      />
    </>
  );
}
