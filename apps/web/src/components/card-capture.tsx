'use client';
/**
 * P-04 Card capture and P-05 Card review (W-14 uses the review in the work queue panel; DEC-31).
 * The photos go to encrypted storage, the worker reads them, and a person confirms the fields
 * before they change the coverage. Fields the reader was not sure about are marked and focused
 * first. In local and preview, "Use a sample card" draws a synthetic photo of the patient's card.
 */
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition, type ReactElement } from 'react';
import { records } from '@cleanpost/domain';
import { Button, Callout, Checkbox, Field, Input, Modal, Select, useToast } from '@cleanpost/ui';
import {
  cardReviewAction,
  cardStateAction,
  confirmCardAction,
  discardCardAction,
  sampleCardAction,
  uploadCardAction,
  type CardReviewData,
} from '@/app/(app)/patients/card-actions';
import type { SampleCard } from '@/lib/sim';

const ORDER: Record<number, string> = { 1: 'Primary', 2: 'Secondary', 3: 'Tertiary' };
const UNREADABLE = 'We could not read this photo. Retake it in good light with all four corners visible.';

/** A synthetic card photo, drawn with the app's own tokens, carrying its answer (stand-in reader). */
async function drawSampleCard(card: SampleCard): Promise<File> {
  const css = getComputedStyle(document.documentElement);
  const token = (name: string) => css.getPropertyValue(name).trim();
  const canvas = document.createElement('canvas');
  canvas.width = 1012;
  canvas.height = 638;
  const g = canvas.getContext('2d')!;
  const sans = token('--font-sans') || 'sans-serif';
  const mono = token('--font-mono') || 'monospace';
  g.fillStyle = token('--surface');
  g.fillRect(0, 0, 1012, 638);
  g.fillStyle = token('--cobalt');
  g.fillRect(0, 0, 1012, 132);
  g.fillStyle = token('--on-cobalt');
  g.font = `700 52px ${sans}`;
  g.fillText(card.payerName, 48, 88);
  g.font = `500 26px ${sans}`;
  g.fillText(card.planType, 860, 84);
  const label = (text: string, x: number, y: number) => {
    g.fillStyle = token('--ink-muted');
    g.font = `600 22px ${sans}`;
    g.fillText(text.toUpperCase(), x, y);
  };
  const value = (text: string, x: number, y: number, font = sans, size = 38) => {
    g.fillStyle = token('--ink');
    g.font = `500 ${size}px ${font}`;
    g.fillText(text, x, y);
  };
  label('Member', 48, 200);
  value(card.subscriberName, 48, 246);
  label('Member ID', 48, 318);
  value(card.memberId, 48, 366, mono, 44);
  if (card.groupNumber) {
    label('Group', 600, 318);
    value(card.groupNumber, 600, 366, mono, 40);
  }
  label('RxBIN', 48, 452);
  value(card.rxBin, 48, 494, mono, 32);
  g.fillStyle = token('--ink-muted');
  g.font = `400 24px ${sans}`;
  g.fillText(`Customer service ${card.payerPhone}`, 48, 590);
  g.fillText('Synthetic demo card', 760, 590);
  const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'));
  const png = new Uint8Array(await blob.arrayBuffer());
  const answer = {
    fields: {
      payerName: card.payerName,
      memberId: card.memberId,
      groupNumber: card.groupNumber,
      subscriberName: card.subscriberName,
      planType: card.planType,
      rxBin: card.rxBin,
      payerPhone: card.payerPhone,
    },
    // Small print reads less surely: the group number is the one to check (W-14).
    confidence: {
      payerName: 0.98,
      memberId: 0.96,
      groupNumber: card.groupNumber ? 0.84 : null,
      subscriberName: 0.97,
      planType: 0.95,
      rxBin: 0.93,
      payerPhone: 0.94,
    },
  };
  const bytes = records.addPngText(png, records.SYNTHETIC_CARD_KEYWORD, records.asciiJson(answer));
  return new File([new Uint8Array(bytes)], 'card-front.png', { type: 'image/png' });
}

type Step =
  | { kind: 'choose'; error?: string }
  | { kind: 'reading'; documentId: string }
  | { kind: 'unreadable'; documentId: string }
  | { kind: 'review'; documentId: string };

/** P-04 (and P-05 inside the same dialog once the card is read). */
export function CardUploadDialog({
  patientId,
  trigger,
  coverageId,
  demo,
}: {
  patientId: string;
  trigger: ReactElement;
  /** The coverage the card is for, when it was opened from one (W-13). */
  coverageId?: string | null;
  /** Local and preview: offer a synthetic photo of the patient's card. */
  demo?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>({ kind: 'choose' });
  const [front, setFront] = useState<File | null>(null);
  const [back, setBack] = useState<File | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  // Poll the reading (no PHI in the answer) until it is done, for up to a minute.
  useEffect(() => {
    if (step.kind !== 'reading') return;
    let tries = 0;
    const t = setInterval(async () => {
      tries++;
      const s = await cardStateAction(step.documentId);
      if (s?.state === 'read') setStep({ kind: 'review', documentId: step.documentId });
      else if (s?.state === 'unreadable') setStep({ kind: 'unreadable', documentId: step.documentId });
      else if (tries > 60) {
        clearInterval(t);
        setStep({ kind: 'choose', error: 'Reading is taking too long. Try again in a minute.' });
      }
    }, 1000);
    return () => clearInterval(t);
  }, [step]);

  const reset = () => {
    setStep({ kind: 'choose' });
    setFront(null);
    setBack(null);
  };

  const close = (o: boolean) => {
    // Cancel deletes uploads nobody confirmed (P-04); a card read and left for later waits as W-14.
    if (!o && step.kind !== 'choose' && step.kind !== 'review') void discardCardAction(step.documentId);
    if (!o && step.kind === 'review') router.refresh();
    setOpen(o);
    if (!o) reset();
  };

  const upload = (f: File, b: File | null) =>
    start(async () => {
      const form = new FormData();
      form.set('patientId', patientId);
      form.set('front', f);
      if (b) form.set('back', b);
      const res = await uploadCardAction(form);
      setStep(
        res.ok && res.frontId
          ? { kind: 'reading', documentId: res.frontId }
          : { kind: 'choose', error: res.message },
      );
    });

  const useSample = () =>
    start(async () => {
      const card = await sampleCardAction(patientId);
      if (!card) {
        setStep({ kind: 'choose', error: 'The mock PM has no card for this patient.' });
        return;
      }
      const file = await drawSampleCard(card);
      setFront(file);
      upload(file, null);
    });

  const retake = async () => {
    if (step.kind !== 'choose') await discardCardAction(step.documentId);
    reset();
  };

  return (
    <Modal
      open={open}
      onOpenChange={close}
      trigger={trigger}
      size={step.kind === 'review' ? 'lg' : undefined}
      title={step.kind === 'review' ? 'Review insurance card' : 'Add insurance card'}
      footer={
        step.kind === 'review' ? undefined : (
          <>
            <Button onClick={() => close(false)}>Cancel</Button>
            {step.kind === 'choose' && (
              <Button
                variant="primary"
                disabled={pending || !front}
                aria-busy={pending || undefined}
                onClick={() => front && upload(front, back)}
              >
                {pending ? 'Uploading…' : 'Upload and read'}
              </Button>
            )}
            {step.kind === 'unreadable' && (
              <Button variant="primary" onClick={retake}>
                Choose another photo
              </Button>
            )}
          </>
        )
      }
    >
      {step.kind === 'choose' && (
        <div className="stack">
          <p className="muted dense">
            A photo of each side, JPEG, PNG or WebP, up to 15 MB. Photos are stored encrypted and read
            automatically; you confirm the fields before anything changes.
          </p>
          <Field label="Front of the card">
            {(p) => (
              <Input
                {...p}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={(e) => setFront(e.currentTarget.files?.[0] ?? null)}
              />
            )}
          </Field>
          <Field label="Back of the card (optional)">
            {(p) => (
              <Input
                {...p}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={(e) => setBack(e.currentTarget.files?.[0] ?? null)}
              />
            )}
          </Field>
          {demo && (
            <div className="row" style={{ gap: 8 }}>
              <Button size="sm" variant="ghost" disabled={pending} onClick={useSample}>
                Use a sample card (demo)
              </Button>
              <span className="muted dense">
                Draws the patient&apos;s card from the mock PM. Preview only.
              </span>
            </div>
          )}
          {step.error && (
            <p className="error" role="alert">
              {step.error}
            </p>
          )}
        </div>
      )}
      {step.kind === 'reading' && (
        <div className="stack-sm" role="status" aria-live="polite">
          <b>Reading the card…</b>
          <span className="skeleton" style={{ width: '70%' }} />
          <span className="skeleton" style={{ width: '45%' }} />
        </div>
      )}
      {step.kind === 'unreadable' && (
        <p className="error" role="alert">
          {UNREADABLE}
        </p>
      )}
      {step.kind === 'review' && (
        <CardReview
          documentId={step.documentId}
          coverageId={coverageId ?? null}
          onDone={() => {
            setOpen(false);
            reset();
            router.refresh();
          }}
          onRetake={retake}
        />
      )}
    </Modal>
  );
}

const FIELD_LABEL = {
  memberId: 'Member ID',
  groupNumber: 'Group number',
  subscriberName: 'Name on the card',
  payerName: 'Payer',
} as const;

/** P-05 / W-14: the card next to what was read; the person confirms or corrects it. */
export function CardReview({
  documentId,
  coverageId,
  onDone,
  onRetake,
}: {
  documentId: string;
  coverageId: string | null;
  onDone: () => void;
  onRetake?: () => void;
}) {
  const [data, setData] = useState<CardReviewData | null | undefined>(undefined);
  const [form, setForm] = useState({
    coverageId: '',
    payerId: '',
    memberId: '',
    groupNumber: '',
    checkEligibility: true,
  });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const toast = useToast();
  const firstUnsure = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let live = true;
    cardReviewAction(documentId).then((d) => {
      if (!live) return;
      setData(d);
      if (!d) return;
      const target =
        d.coverages.find((c) => c.id === coverageId) ??
        d.coverages.find((c) => c.payerId === d.card.matchedPayerId) ??
        d.coverages.find((c) => c.priority === 1) ??
        d.coverages[0];
      setForm({
        coverageId: target?.id ?? '',
        payerId: d.card.matchedPayerId ?? '',
        memberId: d.card.fields.memberId ?? '',
        groupNumber: d.card.fields.groupNumber ?? '',
        checkEligibility: true,
      });
    });
    return () => {
      live = false;
    };
  }, [documentId, coverageId]);

  // Fields under 0.9 are focused first (P-05).
  useEffect(() => {
    if (data) firstUnsure.current?.focus();
  }, [data]);

  if (data === undefined) return <p className="muted">Loading the card…</p>;
  if (data === null) return <p className="error">This card is not available.</p>;
  const { card } = data;
  if (card.reviewStatus !== 'pending') return <p className="muted">This card was already confirmed.</p>;
  const unsure = new Set<string>(card.unsure);
  const unsureNote = (f: keyof typeof card.fields) =>
    unsure.has(f)
      ? card.fields[f] == null
        ? 'Not found on the card.'
        : `Check this: read with ${Math.round((card.confidence[f] ?? 0) * 100)}% confidence.`
      : undefined;
  let focused = false;
  const focusRef = (f: string) => (el: HTMLElement | null) => {
    if (!focused && unsure.has(f) && el) {
      firstUnsure.current = el;
      focused = true;
    }
  };
  const payerName = data.payers.find((p) => p.id === form.payerId)?.name;
  const target = data.coverages.find((c) => c.id === form.coverageId);

  const confirm = () =>
    start(async () => {
      setError(null);
      const res = await confirmCardAction(documentId, form);
      if (!res.ok) {
        setError(res.message);
        return;
      }
      toast({ message: res.message });
      onDone();
    });

  return (
    <div className="stack">
      <div className="grid-2" style={{ alignItems: 'start' }}>
        <div className="stack-sm">
          {/* A plain img: the source is a short-lived signed link that must not be cached or optimised. */}
          <img
            src={data.frontUrl}
            alt="Front of the insurance card"
            style={{ width: '100%', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)' }}
          />
          {data.backUrl && (
            <img
              src={data.backUrl}
              alt="Back of the insurance card"
              style={{ width: '100%', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)' }}
            />
          )}
          {card.fields.planType && <span className="muted dense">Plan type {card.fields.planType}</span>}
          {(card.fields.rxBin || card.fields.payerPhone) && (
            <span className="muted dense">
              {card.fields.rxBin && (
                <>
                  RxBIN <span className="code">{card.fields.rxBin}</span> ·{' '}
                </>
              )}
              {card.fields.payerPhone && <>Customer service {card.fields.payerPhone}</>}
            </span>
          )}
        </div>
        <div className="stack">
          <Field label="Coverage to update">
            {(p) => (
              <Select
                {...p}
                value={form.coverageId}
                onChange={(e) => setForm({ ...form, coverageId: e.target.value })}
              >
                {data.coverages.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.payerName} · {ORDER[c.priority] ?? c.priority} · {c.memberIdMasked}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            label={FIELD_LABEL.payerName}
            error={
              !card.matchedPayerId
                ? `No match found for “${card.fields.payerName ?? 'the payer'}”. Choose the payer.`
                : unsureNote('payerName')
            }
          >
            {(p) => (
              <Select
                {...p}
                ref={focusRef('payerName')}
                value={form.payerId}
                onChange={(e) => setForm({ ...form, payerId: e.target.value })}
              >
                {!form.payerId && <option value="">Choose a payer</option>}
                {data.payers.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={FIELD_LABEL.memberId} error={unsureNote('memberId')}>
            {(p) => (
              <Input
                {...p}
                ref={focusRef('memberId')}
                mono
                autoComplete="off"
                spellCheck={false}
                value={form.memberId}
                onChange={(e) => setForm({ ...form, memberId: e.target.value })}
              />
            )}
          </Field>
          <Field label={FIELD_LABEL.groupNumber} error={unsureNote('groupNumber')}>
            {(p) => (
              <Input
                {...p}
                ref={focusRef('groupNumber')}
                mono
                autoComplete="off"
                value={form.groupNumber}
                onChange={(e) => setForm({ ...form, groupNumber: e.target.value })}
              />
            )}
          </Field>
          <span className="muted dense">
            {FIELD_LABEL.subscriberName}: {card.fields.subscriberName ?? 'not found'}
            {unsure.has('subscriberName') ? ' (check it matches the patient)' : ''}
          </span>
          {target && payerName && target.payerName !== payerName && (
            <Callout>
              The card says {payerName}, the coverage on file says {target.payerName}. Confirming moves this
              coverage to {payerName}.
            </Callout>
          )}
          <Callout>
            Confirming updates the coverage in Cleanpost and puts a task in the queue to update {data.pmName}.
          </Callout>
          <Checkbox
            label="Check eligibility after saving"
            checked={form.checkEligibility}
            onChange={(e) => setForm({ ...form, checkEligibility: e.currentTarget.checked })}
          />
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
            {onRetake && (
              <Button variant="ghost" disabled={pending} onClick={onRetake}>
                Upload clearer photo
              </Button>
            )}
            <Button
              variant="primary"
              disabled={pending || !form.payerId || !form.coverageId}
              aria-busy={pending || undefined}
              onClick={confirm}
            >
              {pending ? 'Confirming…' : 'Confirm card'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** P-05 opened from a card listed on P-01 (or anywhere a card waits for review). */
export function CardReviewDialog({ documentId, trigger }: { documentId: string; trigger: ReactElement }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  return (
    <Modal open={open} onOpenChange={setOpen} trigger={trigger} size="lg" title="Review insurance card">
      {open && (
        <CardReview
          documentId={documentId}
          coverageId={null}
          onDone={() => {
            setOpen(false);
            router.refresh();
          }}
        />
      )}
    </Modal>
  );
}
