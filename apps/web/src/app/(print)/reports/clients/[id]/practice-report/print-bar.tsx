'use client';
/** F-01 toolbar (not printed): back to the client report, a note, and Download PDF (the browser's save as PDF). */
import Link from 'next/link';
import { ArrowLeft, Download } from 'lucide-react';
import { Button } from '@cleanpost/ui';

/** `noLogo` is the company name shown as text; admins get the way to Branding (S-10). */
export function PrintBar({
  backHref,
  noLogo,
}: {
  backHref: string;
  noLogo?: { company: string; canEdit: boolean } | null;
}) {
  return (
    <div className="print-bar no-print">
      <Link className="breadcrumb" href={backHref}>
        <ArrowLeft aria-hidden />
        Client report
      </Link>
      <span className="spacer" />
      <span className="muted dense">
        Add a note below, then save it as a PDF from the print dialog.
        {noLogo && (
          <>
            {' '}
            Uses {noLogo.company} as text.
            {noLogo.canEdit && (
              <>
                {' '}
                <Link className="inline-link" href="/settings/branding">
                  Add a logo in Branding.
                </Link>
              </>
            )}
          </>
        )}
      </span>
      <Button variant="primary" size="sm" onClick={() => window.print()}>
        <Download aria-hidden />
        Download PDF
      </Button>
    </div>
  );
}

/** The billing company's note to the practice: typed before export, printed as typed. */
export function PracticeNote({ company }: { company: string }) {
  return (
    <section className="doc-note is-blank">
      <h2>Notes from {company}</h2>
      <textarea
        aria-label={`Notes from ${company}`}
        placeholder="Payer changes, action items for the practice… (optional; left out of the PDF when empty)"
        rows={3}
        onInput={(e) => {
          const t = e.currentTarget;
          t.style.height = 'auto';
          t.style.height = `${t.scrollHeight}px`;
          t.closest('.doc-note')?.classList.toggle('is-blank', t.value.trim() === '');
        }}
      />
    </section>
  );
}
