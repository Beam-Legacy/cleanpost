'use client';
/**
 * R-02 Upload 835: choose files, check what they hold (payer, trace, claims, amount, balance check,
 * client by payee NPI, already imported), untick any to skip, then import. The files stay in the
 * browser between the two steps and are sent again on import, so nothing is stored half-read.
 */
import { useRef, useState, useTransition } from 'react';
import { CircleCheck, TriangleAlert, Upload } from 'lucide-react';
import { Banner, Button, Modal, useToast } from '@cleanpost/ui';
import { formatDate, formatMoney } from '@/lib/format';
import { importUpload, previewUpload, type UploadPayment } from './actions';

/** G-03 "Upload 835 file" opens the page with the dialog open (?upload=1). */
export function UploadButton({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <>
      <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
        <Upload aria-hidden />
        Upload 835
      </Button>
      {open && <UploadDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function UploadDialog({ onClose }: { onClose: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [payments, setPayments] = useState<UploadPayment[] | null>(null);
  const [keep, setKeep] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const toast = useToast();

  const form = (extra?: (f: FormData) => void) => {
    const f = new FormData();
    for (const file of files) f.append('files', file);
    extra?.(f);
    return f;
  };
  const choose = (list: FileList | null) => {
    const chosen = [...(list ?? [])];
    setFiles(chosen);
    setPayments(null);
    setError(null);
    if (!chosen.length) return;
    start(async () => {
      const f = new FormData();
      for (const file of chosen) f.append('files', file);
      const res = await previewUpload(f);
      if (!res.ok) {
        setError(res.message);
        return;
      }
      setPayments(res.payments);
      setKeep(new Set(res.payments.filter((p) => p.clientId && !p.importedOn).map((p) => p.key)));
    });
  };
  const doImport = () =>
    start(async () => {
      const res = await importUpload(form((f) => keep.forEach((k) => f.append('keep', k))));
      toast({ message: res.message, ...(res.ok ? {} : { tone: 'bad' as const }) });
      if (res.ok) onClose();
    });

  const clientsNamed = [...new Set((payments ?? []).map((p) => p.clientName).filter(Boolean))];
  const duplicates = (payments ?? []).filter((p) => p.importedOn);
  const orphans = (payments ?? []).filter((p) => !p.clientId);
  const n = keep.size;

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Upload 835"
      description="X12 835 files from the clearinghouse or your PM."
      size="lg"
      footer={
        <>
          <span className="left subtle">
            {payments ? 'Each payment is checked against what the PM posted once it is in.' : ''}
          </span>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!n || pending} onClick={doImport}>
            {n ? `Import ${n} ${n === 1 ? 'payment' : 'payments'}` : 'Import'}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div
          className="callout row"
          style={{ border: '1px dashed var(--border-control)', background: 'var(--canvas)', gap: 12 }}
        >
          <Upload aria-hidden />
          <span>
            <b>Choose 835 files</b> (several at once is fine)
          </span>
          <span className="spacer" />
          <input
            ref={input}
            type="file"
            multiple
            accept=".835,.edi,.txt,.x12"
            aria-label="835 files"
            onChange={(e) => choose(e.target.files)}
          />
        </div>
        {pending && !payments && <span className="muted">Reading…</span>}
        {error && <Banner tone="bad">{error}</Banner>}
        {payments && (
          <>
            <div className="balance">
              <b>
                Read {payments.length} {payments.length === 1 ? 'payment' : 'payments'}
              </b>
              <span>
                from {files.length} {files.length === 1 ? 'file' : 'files'}
                {clientsNamed.length ? ` · ${clientsNamed.join(', ')}` : ''}
              </span>
            </div>
            <div className="card flush">
              <table className="table nowrap" aria-label="Payments in the files">
                <thead>
                  <tr>
                    <th className="w-check">
                      <span className="sr-only">Import</span>
                    </th>
                    <th>Payer</th>
                    <th>Trace</th>
                    <th>Paid on</th>
                    <th>Client</th>
                    <th className="num">Claims</th>
                    <th className="num">Amount</th>
                    <th>Check</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((p) => {
                    const importable = Boolean(p.clientId) && !p.importedOn;
                    return (
                      <tr key={p.key} className={importable ? undefined : 'row-muted'}>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`Import ${p.payerName} ${p.traceNumber}`}
                            checked={keep.has(p.key)}
                            disabled={!importable}
                            onChange={(e) => {
                              const next = new Set(keep);
                              if (e.target.checked) next.add(p.key);
                              else next.delete(p.key);
                              setKeep(next);
                            }}
                          />
                        </td>
                        <td>{p.payerName}</td>
                        <td className="code">{p.traceNumber}</td>
                        <td>{formatDate(p.paymentDate).replace(/, \d{4}$/, '')}</td>
                        <td>{p.clientName ?? <span className="muted">No matching client</span>}</td>
                        <td className="num">{p.claims}</td>
                        <td className="num">{formatMoney(p.amountCents)}</td>
                        <td>
                          {p.importedOn ? (
                            <span className="chip chip-warn">
                              <TriangleAlert aria-hidden />
                              Already imported {p.importedOn.replace(/, \d{4}$/, '')}
                            </span>
                          ) : p.balanced ? (
                            <span className="chip chip-good">
                              <CircleCheck aria-hidden />
                              Balances
                            </span>
                          ) : (
                            <span className="chip chip-bad">
                              <TriangleAlert aria-hidden />
                              Does not balance
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {duplicates.length > 0 && (
              <Banner tone="warn">
                {duplicates.length === 1
                  ? `${duplicates[0]!.payerName} ${duplicates[0]!.traceNumber} was imported on ${duplicates[0]!.importedOn}. It will be skipped so nothing is counted twice.`
                  : `${duplicates.length} payments were imported before and will be skipped.`}
              </Banner>
            )}
            {orphans.length > 0 && (
              <Banner tone="warn">
                {orphans.length === 1 ? 'One payment is' : `${orphans.length} payments are`} for a payee NPI
                that matches none of your clients, so {orphans.length === 1 ? 'it' : 'they'} cannot be
                imported.
              </Banner>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
