'use client';
/**
 * C-08 Claim editor: the editable claim on the left, live findings on the right (the scrub re-runs
 * on each change, debounced), and every change listed in the footer. Save makes a new version with
 * one corrections row per change; in Mode A the worker writes it to the PM.
 *
 * Patient, payer, providers, dates and charges come from the PM and are read-only here.
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { diffPayload, type ClaimPayload, type Finding } from '@cleanpost/domain';
import { Button, ConfidenceMeter, FindingRow, IconButton, useToast } from '@cleanpost/ui';
import { formatMoney } from '@/lib/format';
import { previewEdit, saveEdit } from './actions';

interface Scored {
  confidence: number;
  findings: Finding[];
  deductions: { reason: string; points: number }[];
}

const splitList = (s: string) =>
  s
    .split(/[\s,]+/)
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean);

export function ClaimEditor({
  claimId,
  versionId,
  payload,
  threshold,
  initial,
  mode,
  pmName,
  canRelease,
}: {
  claimId: string;
  versionId: string;
  payload: ClaimPayload;
  threshold: number;
  initial: Scored | null;
  mode: 'A' | 'B' | 'C';
  pmName: string;
  canRelease: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [draft, setDraft] = useState<ClaimPayload>(() => structuredClone(payload));
  const [scored, setScored] = useState<Scored | null>(initial);
  const [problem, setProblem] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, start] = useTransition();
  const changes = useMemo(() => diffPayload(payload, draft), [payload, draft]);
  const seq = useRef(0);

  // Re-score on each change, 400 ms after the last keystroke (C-08 "live findings").
  useEffect(() => {
    if (!changes.length) {
      setScored(initial);
      setProblem(null);
      return;
    }
    const n = ++seq.current;
    setChecking(true);
    const t = setTimeout(() => {
      void previewEdit(claimId, versionId, draft)
        .then((r) => {
          if (n !== seq.current) return;
          if (r.status === 'scored') {
            setScored({ confidence: r.confidence, findings: r.findings, deductions: r.deductions });
            setProblem(null);
          } else {
            setProblem(
              r.reason === 'invalid_value'
                ? 'A value is not valid yet: codes are 5 characters, modifiers 2, units 1 to 999, pointers point at a diagnosis.'
                : r.reason === 'stale'
                  ? 'This claim changed since you opened it. Reload to edit the latest version.'
                  : 'This change is not allowed here.',
            );
          }
        })
        .catch(() => n === seq.current && setProblem('Could not check the change.'))
        .finally(() => n === seq.current && setChecking(false));
    }, 400);
    return () => clearTimeout(t);
  }, [draft, changes.length, claimId, versionId, initial]);

  const setLine = (i: number, patch: Partial<ClaimPayload['lines'][number]>) =>
    setDraft((d) => ({ ...d, lines: d.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));
  const setDx = (i: number, icd10: string) =>
    setDraft((d) => ({ ...d, diagnoses: d.diagnoses.map((x, j) => (j === i ? { ...x, icd10 } : x)) }));

  const save = (andRelease: boolean) =>
    start(async () => {
      const res = await saveEdit(claimId, versionId, draft, andRelease);
      toast({ message: res.message, ...(res.ok ? {} : { tone: 'bad' as const }) });
      if (res.versionId) router.push(`/claims/${claimId}`);
    });

  const blocking = scored?.findings.some((f) => f.severity === 'block') ?? false;
  return (
    <div className="split">
      <div className="split-main stack">
        <div className="card">
          <div className="card-head">
            <h2>Lines</h2>
            <span className="muted dense">Codes only. Charges come from {pmName}.</span>
          </div>
          <div className="card-body">
            <table className="table" aria-label="Edit claim lines">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Code</th>
                  <th>Modifiers</th>
                  <th>Units</th>
                  <th>Diagnosis pointers</th>
                  <th className="num">Charge</th>
                  <th>
                    <span className="sr-only">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {draft.lines.map((l, i) => {
                  const orig = payload.lines.find((x) => x.chargeLineId === l.chargeLineId);
                  const changed = (k: 'code' | 'modifiers' | 'units' | 'dxPointers') =>
                    JSON.stringify(orig?.[k]) !== JSON.stringify(l[k])
                      ? { background: 'var(--warning-tint)' }
                      : undefined;
                  return (
                    <tr key={l.chargeLineId}>
                      <td>{i + 1}</td>
                      <td>
                        <input
                          className="input mono"
                          aria-label={`Line ${i + 1} code`}
                          value={l.code}
                          maxLength={5}
                          size={6}
                          style={changed('code')}
                          onChange={(e) => setLine(i, { code: e.target.value.toUpperCase() })}
                        />
                      </td>
                      <td>
                        <input
                          className="input mono"
                          aria-label={`Line ${i + 1} modifiers`}
                          defaultValue={l.modifiers.join(' ')}
                          size={12}
                          style={changed('modifiers')}
                          onChange={(e) => setLine(i, { modifiers: splitList(e.target.value).slice(0, 4) })}
                        />
                      </td>
                      <td>
                        <input
                          className="input"
                          type="number"
                          aria-label={`Line ${i + 1} units`}
                          value={l.units}
                          min={1}
                          max={999}
                          style={{ width: 72, ...changed('units') }}
                          onChange={(e) => setLine(i, { units: Number.parseInt(e.target.value, 10) || 0 })}
                        />
                      </td>
                      <td>
                        <input
                          className="input mono"
                          aria-label={`Line ${i + 1} diagnosis pointers`}
                          defaultValue={l.dxPointers.join(' ')}
                          size={8}
                          style={changed('dxPointers')}
                          onChange={(e) =>
                            setLine(i, {
                              dxPointers: splitList(e.target.value)
                                .map((x) => Number.parseInt(x, 10))
                                .filter((x) => Number.isInteger(x))
                                .slice(0, 4),
                            })
                          }
                        />
                      </td>
                      <td className="num">{formatMoney(l.chargeCents)}</td>
                      <td>
                        <IconButton
                          label={`Remove line ${i + 1}`}
                          icon={<Trash2 />}
                          ghost
                          disabled={draft.lines.length === 1}
                          onClick={() =>
                            setDraft((d) => ({ ...d, lines: d.lines.filter((_, j) => j !== i) }))
                          }
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h2>Diagnoses</h2>
          </div>
          <div className="card-body stack-sm">
            {draft.diagnoses.map((x, i) => (
              <div className="row" key={i} style={{ flexWrap: 'nowrap' }}>
                <span className="muted" style={{ width: 24 }}>
                  {i + 1}
                </span>
                <input
                  className="input mono"
                  aria-label={`Diagnosis ${i + 1}`}
                  value={x.icd10}
                  maxLength={8}
                  size={9}
                  style={{ width: 120 }}
                  onChange={(e) => setDx(i, e.target.value.toUpperCase())}
                />
                <IconButton
                  label={`Remove diagnosis ${i + 1}`}
                  icon={<Trash2 />}
                  ghost
                  disabled={draft.diagnoses.length === 1}
                  onClick={() =>
                    setDraft((d) => ({ ...d, diagnoses: d.diagnoses.filter((_, j) => j !== i) }))
                  }
                />
              </div>
            ))}
            {draft.diagnoses.length < 12 && (
              <div>
                <Button
                  size="sm"
                  onClick={() =>
                    setDraft((d) => ({
                      ...d,
                      diagnoses: [...d.diagnoses, { sequence: d.diagnoses.length + 1, icd10: '' }],
                    }))
                  }
                >
                  <Plus aria-hidden />
                  Add diagnosis
                </Button>
              </div>
            )}
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h2>Claim</h2>
          </div>
          <div className="card-body row" style={{ gap: 24, flexWrap: 'wrap' }}>
            <label className="field">
              <span className="label">Prior authorization number</span>
              <input
                className="input mono"
                value={draft.priorAuthNumber ?? ''}
                maxLength={50}
                style={{ width: 200 }}
                onChange={(e) => setDraft((d) => ({ ...d, priorAuthNumber: e.target.value.trim() || null }))}
              />
            </label>
            {draft.facility && (
              <label className="field">
                <span className="label">Place of service</span>
                <input
                  className="input mono"
                  value={draft.facility.placeOfService}
                  maxLength={2}
                  size={3}
                  onChange={(e) =>
                    setDraft((d) =>
                      d.facility ? { ...d, facility: { ...d.facility, placeOfService: e.target.value } } : d,
                    )
                  }
                />
              </label>
            )}
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h2>Changes</h2>
            <span className="muted dense">
              {mode === 'A'
                ? `Saved changes are written to ${pmName}, or become a task where ${pmName} cannot be changed from here.`
                : 'Saved changes become a new version.'}
            </span>
          </div>
          <div className="card-body stack-sm">
            {changes.length === 0 ? (
              <span className="muted">No changes yet.</span>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 18 }} aria-label="Changes made">
                {changes.map((c) => (
                  <li key={c.fieldPath}>{c.label}</li>
                ))}
              </ul>
            )}
          </div>
          <div className="card-foot row">
            <Button
              variant="primary"
              disabled={!changes.length || saving || Boolean(problem)}
              onClick={() => save(false)}
            >
              Save as new version
            </Button>
            {canRelease && (
              <Button
                disabled={!changes.length || saving || Boolean(problem) || blocking}
                onClick={() => save(true)}
              >
                Save and release
              </Button>
            )}
            <span className="spacer" />
            <Link href={`/claims/${claimId}`}>Cancel</Link>
          </div>
        </div>
      </div>
      <aside
        className="card"
        style={{ width: 400, flex: 'none', position: 'sticky', top: 16 }}
        aria-label="Live findings"
      >
        <div className="card-head">
          <h2>Findings</h2>
          <span className="muted dense" aria-live="polite">
            {checking ? 'Checking…' : changes.length ? 'Updated for your changes' : 'As last scrubbed'}
          </span>
        </div>
        <div className="card-body stack-sm">
          {problem && <FindingRow severity="block" title={problem} />}
          {scored && <ConfidenceMeter score={scored.confidence} threshold={threshold} />}
          {scored?.findings.length === 0 && <span className="muted">No findings.</span>}
          {scored?.findings.map((f, i) => (
            <FindingRow key={`${f.ruleId}-${i}`} severity={f.severity} title={f.message} meta={f.ruleId} />
          ))}
        </div>
      </aside>
    </div>
  );
}
