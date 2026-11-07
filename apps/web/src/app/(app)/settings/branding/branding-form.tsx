'use client';
/**
 * S-10 form and live preview: the name on reports, the logo (replace or remove), the contact line,
 * the footer note and the "Prepared with Cleanpost" credit. The preview follows the fields as they
 * are typed; Open full preview renders F-01 with last month for one client.
 */
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { Eye, Upload } from 'lucide-react';
import { Button, Checkbox, Field, Input, Textarea, useToast } from '@cleanpost/ui';
import { company } from '@cleanpost/domain';
import { removeLogo, saveBranding, uploadLogo } from './actions';

function Mark({ initials, logoUrl, size }: { initials: string; logoUrl: string | null; size: number }) {
  if (logoUrl)
    return <img src={logoUrl} alt="" style={{ height: size, width: 'auto', maxWidth: size * 4 }} />;
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: size / 5,
        background: 'var(--ink)',
        color: 'var(--canvas)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontWeight: 700,
        fontSize: size / 2.6,
        flex: 'none',
      }}
    >
      {initials}
    </span>
  );
}

export function BrandingForm({
  companyName,
  branding,
  logoUrl,
  sample,
}: {
  companyName: string;
  branding: company.Branding;
  logoUrl: string | null;
  sample: { id: string; name: string; label: string; figures: string[][] } | null;
}) {
  const [v, setV] = useState({
    reportName: branding.reportName ?? '',
    contactLine: branding.contactLine ?? '',
    footerNote: branding.footerNote ?? '',
    showCredit: branding.showCredit,
  });
  const [logoError, setLogoError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const file = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const router = useRouter();
  const brand = company.reportBrand(companyName, {
    ...branding,
    reportName: v.reportName.trim() || null,
    contactLine: v.contactLine.trim() || null,
    footerNote: v.footerNote.trim() || null,
    showCredit: v.showCredit,
  });

  const save = () =>
    start(async () => {
      const res = await saveBranding(v);
      toast({ message: res.message, ...(res.ok ? {} : { tone: 'bad' as const }) });
      if (res.ok) router.refresh();
    });

  const upload = (f: File) =>
    start(async () => {
      const form = new FormData();
      form.set('logo', f);
      const res = await uploadLogo(form);
      setLogoError(res.ok ? null : res.message);
      if (file.current) file.current.value = '';
      if (res.ok) {
        toast({ message: res.message });
        router.refresh();
      }
    });

  const remove = () =>
    start(async () => {
      const res = await removeLogo();
      setLogoError(null);
      toast({ message: res.message, ...(res.ok ? {} : { tone: 'bad' as const }) });
      router.refresh();
    });

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <div className="row-between">
        <div>
          <h2 className="title-m">Branding</h2>
          <p className="muted dense" style={{ margin: 0 }}>
            How client reports look to your practices
          </p>
        </div>
        <Button type="submit" size="sm" variant="primary" disabled={pending} aria-busy={pending}>
          Save
        </Button>
      </div>
      <div className="split">
        <div className="split-main card">
          <div className="card-body stack">
            <Field label="Company name on reports" help={`Empty uses your display name, ${companyName}.`}>
              {(p) => (
                <Input
                  {...p}
                  value={v.reportName}
                  placeholder={companyName}
                  maxLength={80}
                  onChange={(e) => {
                    const t = e.currentTarget.value;
                    setV((s) => ({ ...s, reportName: t }));
                  }}
                />
              )}
            </Field>
            <div className="field">
              <span className="label" id="logo-label">
                Logo
              </span>
              <div className="row" style={{ gap: 8 }}>
                <Mark initials={brand.initials} logoUrl={logoUrl} size={48} />
                <input
                  ref={file}
                  id="logo-file"
                  type="file"
                  accept="image/png,image/svg+xml"
                  className="sr-only"
                  aria-labelledby="logo-label"
                  aria-describedby="logo-help"
                  onChange={(e) => {
                    const f = e.currentTarget.files?.[0];
                    if (f) upload(f);
                  }}
                />
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={pending}
                  onClick={() => file.current?.click()}
                >
                  <Upload aria-hidden />
                  {logoUrl ? 'Replace' : 'Upload'}
                </Button>
                {logoUrl && (
                  <Button size="sm" variant="ghost" disabled={pending} onClick={remove}>
                    Remove
                  </Button>
                )}
              </div>
              {logoError && (
                <span className="error" role="alert">
                  {logoError}
                </span>
              )}
              <span className="help" id="logo-help">
                PNG or SVG, at least {company.LOGO_MIN_WIDTH} px wide. Shown at the top of every page.
              </span>
            </div>
            <Field label="Contact line" help="Under every report, so practices know whom to ask.">
              {(p) => (
                <Input
                  {...p}
                  value={v.contactLine}
                  maxLength={160}
                  placeholder="billing@yourcompany.com · (541) 555-0100"
                  onChange={(e) => {
                    const t = e.currentTarget.value;
                    setV((s) => ({ ...s, contactLine: t }));
                  }}
                />
              )}
            </Field>
            <Field label="Footer note">
              {(p) => (
                <Textarea
                  {...p}
                  value={v.footerNote}
                  maxLength={300}
                  rows={3}
                  onChange={(e) => {
                    const t = e.currentTarget.value;
                    setV((s) => ({ ...s, footerNote: t }));
                  }}
                />
              )}
            </Field>
            <Checkbox
              label='Show "Prepared with Cleanpost" in the footer'
              checked={v.showCredit}
              onChange={(e) => {
                const c = e.currentTarget.checked;
                setV((s) => ({ ...s, showCredit: c }));
              }}
            />
          </div>
        </div>
        <div className="stack-sm" style={{ flex: 'none' }}>
          <span className="overline" id="preview-label">
            Preview
          </span>
          <div
            className="card"
            role="figure"
            aria-labelledby="preview-label"
            style={{
              width: 260,
              padding: 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              boxShadow: 'var(--shadow-overlay)',
            }}
          >
            <div className="row" style={{ gap: 8 }}>
              <Mark initials={brand.initials} logoUrl={logoUrl} size={28} />
              <b className="dense">{brand.name}</b>
            </div>
            <div className="dense" style={{ fontWeight: 600 }}>
              {sample?.name ?? 'Your client'}
              <br />
              <span className="subtle">{sample ? `${sample.label} results` : 'Last month results'}</span>
            </div>
            <div className="grid-2" style={{ gap: 6 }}>
              {(
                sample?.figures ?? [
                  ['Collections', '—'],
                  ['First-pass', '—'],
                  ['Denial rate', '—'],
                  ['Days in A/R', '—'],
                ]
              ).map(([k, val]) => (
                <div key={k} className="callout" style={{ padding: '6px 8px' }}>
                  <div className="subtle">{k}</div>
                  <b className="dense">{val}</b>
                </div>
              ))}
            </div>
            <div className="ghost-line" />
            <div className="ghost-line" style={{ width: '70%' }} />
            <div className="ghost-line" style={{ width: '85%' }} />
            <div className="subtle" style={{ borderTop: '1px solid var(--border)', paddingTop: 6 }}>
              {brand.contactLine && <div>Questions? {brand.contactLine}</div>}
              {brand.footerNote && <div>{brand.footerNote}</div>}
              {brand.credit && <div>Prepared with Cleanpost</div>}
              {!brand.contactLine && !brand.footerNote && !brand.credit && <div>{brand.name}</div>}
            </div>
          </div>
          {sample && (
            <a
              className="btn btn-ghost btn-sm"
              href={`/reports/clients/${sample.id}/practice-report?period=last_month`}
              target="_blank"
              rel="noopener"
            >
              <Eye aria-hidden />
              Open full preview
            </a>
          )}
        </div>
      </div>
    </form>
  );
}
