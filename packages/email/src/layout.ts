import { escapeHtml } from './escape';

/**
 * Email clients cannot read CSS variables, so emails inline the light-theme values from
 * ui/assets/tokens.css. This is the only place outside tokens.css where these hex values appear.
 */
const T = {
  canvas: '#F5F7FA',
  surface: '#FFFFFF',
  border: '#D8DFE8',
  ink: '#0B1526',
  inkMuted: '#4A5A70',
  cobalt: '#2447D6',
  onCobalt: '#FFFFFF',
  font: '"Public Sans", -apple-system, "Segoe UI", Helvetica, Arial, sans-serif',
};

export interface EmailContent {
  subject: string;
  preview: string;
  html: string;
  text: string;
}

export interface LayoutInput {
  subject: string;
  preview: string;
  heading: string;
  /** Paragraphs and key-value rows, already plain text; escaped here. */
  paragraphs: string[];
  details?: [label: string, value: string][];
  /** Paragraphs shown after the details and before the button. */
  notes?: string[];
  cta?: { label: string; url: string };
  afterCta?: string[];
  reason: string;
  footerLinks?: boolean;
}

export function renderEmail(input: LayoutInput): EmailContent {
  const p = (text: string) =>
    `<p style="margin:0 0 16px;font:400 14px/21px ${T.font};color:${T.ink}">${escapeHtml(text)}</p>`;
  const details = input.details?.length
    ? `<table role="presentation" style="margin:0 0 16px;border-collapse:collapse">${input.details
        .map(
          ([k, v]) =>
            `<tr><td style="padding:4px 16px 4px 0;font:500 13px/18px ${T.font};color:${T.inkMuted}">${escapeHtml(k)}</td><td style="padding:4px 0;font:400 14px/21px ${T.font};color:${T.ink}">${escapeHtml(v)}</td></tr>`,
        )
        .join('')}</table>`
    : '';
  const cta = input.cta
    ? `<p style="margin:8px 0 24px"><a href="${escapeHtml(input.cta.url)}" style="display:inline-block;padding:10px 18px;border-radius:6px;background:${T.cobalt};color:${T.onCobalt};font:600 14px/20px ${T.font};text-decoration:none">${escapeHtml(input.cta.label)}</a></p>`
    : '';
  const footer = input.footerLinks === false ? '' : ' Notification settings · Help';
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(input.subject)}</title></head>
<body style="margin:0;padding:0;background:${T.canvas}">
<div style="display:none;max-height:0;overflow:hidden">${escapeHtml(input.preview)}</div>
<table role="presentation" width="100%" style="background:${T.canvas};padding:32px 16px"><tr><td align="center">
<table role="presentation" width="560" style="max-width:560px;background:${T.surface};border:1px solid ${T.border};border-radius:10px">
<tr><td style="padding:24px 32px 8px;font:700 18px/24px ${T.font};color:${T.ink};letter-spacing:-0.02em">cleanpost</td></tr>
<tr><td style="padding:8px 32px 24px">
<h1 style="margin:0 0 16px;font:600 22px/28px ${T.font};color:${T.ink}">${escapeHtml(input.heading)}</h1>
${input.paragraphs.map(p).join('\n')}
${details}
${(input.notes ?? []).map(p).join('\n')}
${cta}
${(input.afterCta ?? []).map(p).join('\n')}
</td></tr>
<tr><td style="padding:16px 32px;border-top:1px solid ${T.border};font:400 12px/16px ${T.font};color:${T.inkMuted}">${escapeHtml(input.reason + footer)}</td></tr>
</table></td></tr></table>
</body></html>`;
  const text = [
    input.heading,
    '',
    ...input.paragraphs,
    ...(input.details ?? []).map(([k, v]) => `${k}: ${v}`),
    ...(input.notes ?? []),
    ...(input.cta ? ['', `${input.cta.label}: ${input.cta.url}`, ''] : []),
    ...(input.afterCta ?? []),
    '',
    input.reason,
  ].join('\n');
  return { subject: input.subject, preview: input.preview, html, text };
}
