/**
 * S-14 seed (DEC-34): Northwind's company profile, contacts and signed agreements, so the page and
 * the download have something real to show. Harbor RCM keeps no business associate agreement, so
 * its S-14 shows the "No business associate agreement on file" banner. Fills only what is empty:
 * edits made on S-14 survive every preview deploy.
 */
import { and, eq } from 'drizzle-orm';
import type { Database } from '@cleanpost/db';
import { tenantAgreements, tenants } from '@cleanpost/db';
import { putBlob } from '@cleanpost/documents';
import { HARBOR_RCM, NORTHWIND } from './world';

const SIGNED_AT = new Date('2026-07-18T17:00:00Z');

const PROFILES = [
  {
    tenantId: NORTHWIND,
    address: { line: '1200 NW Everett St, Suite 300, Portland, OR 97209' },
    phone: '(503) 555-0142',
    securityContact: { name: 'Priya Shah', email: 'priya@northwind.test' },
    billingContact: { name: 'Julia Beam', email: 'julia@northwind.test' },
    agreements: [
      { type: 'baa', version: '2026.1', title: 'Business associate agreement' },
      { type: 'customer_agreement', version: '2026.1', title: 'Customer agreement' },
    ],
    signedBy: 'Julia Beam',
  },
  {
    tenantId: HARBOR_RCM,
    address: { line: '48 Harbor Blvd, Newport, OR 97365' },
    phone: '(541) 555-0177',
    securityContact: { name: 'Julia Beam', email: 'julia@northwind.test' },
    billingContact: null,
    agreements: [{ type: 'customer_agreement', version: '2026.1', title: 'Customer agreement' }],
    signedBy: 'Julia Beam',
  },
] as const;

/** A one-page PDF with a few lines of text: a stand-in for the signed agreement (synthetic only). */
export function samplePdf(lines: string[]): Uint8Array {
  const esc = (t: string) => t.replace(/[\\()]/g, (c) => `\\${c}`);
  const text = lines
    .map((l, i) => `BT /F1 ${i === 0 ? 16 : 11} Tf 72 ${720 - i * 22} Td (${esc(l)}) Tj ET`)
    .join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

export async function seedCompanyProfiles(systemDb: Database) {
  for (const p of PROFILES) {
    const [t] = await systemDb
      .select({
        name: tenants.name,
        legalName: tenants.legalName,
        address: tenants.address,
        phone: tenants.phone,
        securityContact: tenants.securityContact,
        billingContact: tenants.billingContact,
      })
      .from(tenants)
      .where(eq(tenants.id, p.tenantId));
    if (!t) continue;
    await systemDb
      .update(tenants)
      .set({
        address: t.address ?? p.address,
        phone: t.phone ?? p.phone,
        securityContact: t.securityContact ?? p.securityContact,
        billingContact: t.billingContact ?? p.billingContact,
      })
      .where(eq(tenants.id, p.tenantId));

    for (const a of p.agreements) {
      const [have] = await systemDb
        .select({ id: tenantAgreements.id })
        .from(tenantAgreements)
        .where(and(eq(tenantAgreements.tenantId, p.tenantId), eq(tenantAgreements.type, a.type)));
      if (have) continue;
      const key = `agreements/${a.type}/${p.tenantId}-${a.version}`;
      await systemDb.transaction(async (tx) => {
        await putBlob(tx, {
          tenantId: p.tenantId,
          clientId: null,
          key,
          contentType: 'application/pdf',
          bytes: samplePdf([
            `${a.title}, version ${a.version}`,
            `Between Cleanpost and ${t.legalName ?? t.name}.`,
            `Signed for ${t.legalName ?? t.name} by ${p.signedBy} on July 18, 2026.`,
            'Synthetic sample for the preview environment. Not a real agreement.',
          ]),
        });
        await tx.insert(tenantAgreements).values({
          tenantId: p.tenantId,
          type: a.type,
          version: a.version,
          signedAt: SIGNED_AT,
          signedBy: p.signedBy,
          storageKey: key,
        });
      });
    }
  }
}
