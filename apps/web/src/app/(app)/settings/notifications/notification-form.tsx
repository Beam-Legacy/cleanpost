'use client';
/**
 * S-09 form: a row per event with its channels, the amounts for out-of-balance remittances and
 * large denials, the digest time and quiet hours. "Unsaved changes" until saved.
 */
import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { notify } from '@cleanpost/domain';
import { Button, useToast } from '@cleanpost/ui';
import { saveNotificationSettings } from './actions';

interface Row {
  event: notify.NotifyEvent;
  in_app: boolean;
  email: boolean;
  digest: boolean;
  /** Dollars as typed. */
  amount: string;
}

const DIGEST_TIMES = ['06:00', '06:30', '07:00', '07:30', '08:00', '08:30', '09:00'];
const QUIET = [
  { key: 'none', label: 'None', value: null },
  { key: '20-07', label: '8:00 pm – 7:00 am', value: { start: '20:00', end: '07:00' } },
  { key: '21-07', label: '9:00 pm – 7:00 am', value: { start: '21:00', end: '07:00' } },
  { key: '19-08', label: '7:00 pm – 8:00 am', value: { start: '19:00', end: '08:00' } },
  { key: '22-06', label: '10:00 pm – 6:00 am', value: { start: '22:00', end: '06:00' } },
] as const;

const timeLabel = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
};
const quietKey = (q: { start: string; end: string } | null) =>
  q
    ? (QUIET.find((x) => x.value && x.value.start === q.start && x.value.end === q.end)?.key ?? 'custom')
    : 'none';

export function NotificationForm({
  settings,
  timeZoneLabel,
}: {
  settings: notify.CompanyNotifySettings;
  timeZoneLabel: string;
}) {
  const initial = useMemo<Row[]>(
    () =>
      notify.NOTIFY_EVENTS.map((e) => ({
        event: e,
        ...settings.events[e].channels,
        amount:
          settings.events[e].thresholdCents === null ? '' : String(settings.events[e].thresholdCents! / 100),
      })),
    [settings],
  );
  const [rows, setRows] = useState(initial);
  const [digestTime, setDigestTime] = useState(settings.digestTime);
  const [quiet, setQuiet] = useState<string>(quietKey(settings.quietHours));
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const toast = useToast();
  const router = useRouter();

  const dirty =
    JSON.stringify(rows) !== JSON.stringify(initial) ||
    digestTime !== settings.digestTime ||
    quiet !== quietKey(settings.quietHours);
  const set = (i: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const save = () =>
    start(async () => {
      setError(null);
      const bad = rows.find(
        (r) =>
          notify.EVENT_DEFS[r.event].thresholdCents !== undefined &&
          !/^\d+(\.\d{1,2})?$/.test(r.amount.replace(/[$,]/g, '')),
      );
      if (bad)
        return setError(`Enter a dollar amount for ${notify.EVENT_DEFS[bad.event].label.toLowerCase()}.`);
      const q = QUIET.find((x) => x.key === quiet);
      const res = await saveNotificationSettings({
        events: rows.map((r) => ({
          event: r.event,
          in_app: r.in_app,
          email: r.email,
          digest: r.digest,
          thresholdCents:
            notify.EVENT_DEFS[r.event].thresholdCents === undefined
              ? null
              : Math.round(Number(r.amount.replace(/[$,]/g, '')) * 100),
        })),
        digestTime,
        quietHours: q ? (q.value ? { ...q.value } : null) : settings.quietHours,
      });
      if (!res.ok) return setError(res.message);
      toast({ message: res.message });
      router.refresh();
    });

  return (
    <>
      <div className="card flush">
        <div className="table-wrap">
          <table className="table" aria-label="Who hears about what">
            <thead>
              <tr>
                <th>Event</th>
                <th>Who</th>
                <th className="num">In app</th>
                <th className="num">Email right away</th>
                <th className="num">Daily digest</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const def = notify.EVENT_DEFS[r.event];
                return (
                  <tr key={r.event}>
                    <th scope="row" style={{ fontWeight: 500 }}>
                      <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                        {def.label}
                        {def.thresholdCents !== undefined && (
                          <>
                            <span>{def.thresholdLabel} $</span>
                            <input
                              className="input mono"
                              inputMode="decimal"
                              aria-label={`${def.label} amount in dollars`}
                              value={r.amount}
                              onChange={(e) => set(i, { amount: e.target.value })}
                              style={{ width: 96, height: 30 }}
                            />
                          </>
                        )}
                      </span>
                      {r.event === 'rule_proposed' && (
                        <span className="subtle dense" style={{ display: 'block', fontWeight: 400 }}>
                          Proposals from corrections arrive with S-07.
                        </span>
                      )}
                    </th>
                    <td>{def.audienceLabel}</td>
                    {(['in_app', 'email', 'digest'] as const).map((c) => {
                      const locked = c === 'email' && def.adminEmailLocked;
                      return (
                        <td key={c} className="num">
                          <input
                            type="checkbox"
                            aria-label={`${def.label}: ${c === 'in_app' ? 'in app' : c === 'email' ? 'email right away' : 'daily digest'}`}
                            checked={r[c] || Boolean(locked)}
                            disabled={Boolean(locked)}
                            title={locked ? 'Admins always get this email' : undefined}
                            onChange={(e) => set(i, { [c]: e.target.checked })}
                          />
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <div className="card">
        <div className="card-body form-grid">
          <div className="field">
            <label htmlFor="s09d">Daily digest time</label>
            <select
              id="s09d"
              className="select"
              value={digestTime}
              onChange={(e) => setDigestTime(e.target.value)}
            >
              {DIGEST_TIMES.map((t) => (
                <option key={t} value={t}>
                  {timeLabel(t)}, {timeZoneLabel}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="s09q">Quiet hours (no email)</label>
            <select id="s09q" className="select" value={quiet} onChange={(e) => setQuiet(e.target.value)}>
              {QUIET.map((q) => (
                <option key={q.key} value={q.key}>
                  {q.label}
                </option>
              ))}
              {quiet === 'custom' && settings.quietHours && (
                <option value="custom">
                  {timeLabel(settings.quietHours.start)} – {timeLabel(settings.quietHours.end)}
                </option>
              )}
            </select>
            <span className="help">Timely-filing emails still go during quiet hours.</span>
          </div>
          <p className="muted dense full" style={{ margin: 0 }}>
            Emails never include patient information; they link into Cleanpost. People can turn their own
            emails off in their profile, except that admins always get connection and timely-filing emails.
          </p>
        </div>
      </div>
      <div className="row" style={{ gap: 12, justifyContent: 'flex-end' }}>
        {error && (
          <span role="alert" className="dense" style={{ color: 'var(--danger)' }}>
            {error}
          </span>
        )}
        {dirty && !error && <span className="subtle dense">Unsaved changes</span>}
        <Button variant="primary" disabled={!dirty || pending} onClick={save}>
          {pending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </>
  );
}
