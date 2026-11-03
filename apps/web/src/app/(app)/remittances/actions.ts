'use server';
/**
 * R-02 Upload 835: read the files, show what is in them, then import the payments the person keeps.
 * Each payment is matched to a client by the payee NPI; payments that match no client in the
 * person's scope cannot be imported, and one already imported is skipped (idempotent ingestion).
 * After import the posting match runs at once against what the PM has posted (Modes A and C).
 * Files are read in memory only; nothing from them is logged.
 */
import { now as clockNow } from '@cleanpost/clock';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { clients, providers, remittances, withTenant } from '@cleanpost/db';
import { policy, remit } from '@cleanpost/domain';
import { createLogger } from '@cleanpost/log';
import { acceptDifference, ingestInTx, verifyInTx } from '@cleanpost/remit';
import { parse835, X12Error } from '@cleanpost/x12';
import { formatDate } from '@/lib/format';
import { getDb } from '@/lib/server';
import { requireActiveContext, type ActiveContext } from '@/lib/session';

const log = createLogger({ name: 'web-remit-upload' });
const MAX_FILES = 20;
const MAX_BYTES = 5 * 1024 * 1024;

export interface UploadPayment {
  key: string;
  fileName: string;
  payerName: string;
  traceNumber: string;
  paymentDate: string;
  claims: number;
  amountCents: number;
  balanced: boolean;
  clientId: string | null;
  clientName: string | null;
  /** When the same payment was imported before (Pacific date), else null. */
  importedOn: string | null;
}

export type PreviewResult = { ok: true; payments: UploadPayment[] } | { ok: false; message: string };

interface Parsed {
  key: string;
  fileName: string;
  r: remit.Remittance835;
}

async function readFiles(
  form: FormData,
): Promise<{ ok: true; parsed: Parsed[] } | { ok: false; message: string }> {
  const files = form.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);
  if (!files.length) return { ok: false, message: 'Choose at least one 835 file.' };
  if (files.length > MAX_FILES) return { ok: false, message: `Upload up to ${MAX_FILES} files at a time.` };
  const parsed: Parsed[] = [];
  for (const [i, f] of files.entries()) {
    if (f.size > MAX_BYTES) return { ok: false, message: `${f.name} is larger than 5 MB.` };
    try {
      parsed.push({ key: `${i}`, fileName: f.name, r: parse835(await f.text()) });
    } catch (err) {
      const detail = err instanceof X12Error ? err.message : 'it is not an X12 835 file';
      return { ok: false, message: `${f.name} could not be read: ${detail}. Nothing was imported.` };
    }
  }
  return { ok: true, parsed };
}

/**
 * The client for a payment: the payee NPI against each client's billing (group) NPI and its
 * providers' NPIs, among clients in the person's scope. An NPI that points at two clients is
 * ambiguous and matches none.
 */
async function clientsFor(ctx: ActiveContext, parsed: Parsed[]) {
  const npis = [...new Set(parsed.map((p) => p.r.payee.npi).filter((n): n is string => Boolean(n)))];
  const scopeIds = policy.clientFilter(ctx.actor);
  const inScope =
    scopeIds === 'all'
      ? undefined
      : inArray(clients.id, scopeIds.length ? [...scopeIds] : ['00000000-0000-0000-0000-000000000000']);
  const rows = npis.length
    ? await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => [
        ...(await tx
          .selectDistinct({ npi: providers.npi, clientId: clients.id, clientName: clients.name })
          .from(providers)
          .innerJoin(clients, eq(clients.id, providers.clientId))
          .where(and(inArray(providers.npi, npis), inScope))),
        ...(await tx
          .select({ npi: clients.billingNpi, clientId: clients.id, clientName: clients.name })
          .from(clients)
          .where(and(inArray(clients.billingNpi, npis), inScope))),
      ])
    : [];
  return (npi: string | null) => {
    const hits = [...new Map(rows.filter((r) => r.npi === npi).map((r) => [r.clientId, r])).values()];
    return hits.length === 1 ? hits[0]! : null;
  };
}

export async function previewUpload(form: FormData): Promise<PreviewResult> {
  const ctx = await requireActiveContext();
  if (!policy.authorize(ctx.actor, 'payment.post').allowed)
    return { ok: false, message: 'Your role cannot import payments.' };
  const files = await readFiles(form);
  if (!files.ok) return files;
  const clientOf = await clientsFor(ctx, files.parsed);
  const payments: UploadPayment[] = [];
  for (const p of files.parsed) {
    const c = clientOf(p.r.payee.npi);
    const [prior] = c
      ? await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, (tx) =>
          tx
            .select({ createdAt: remittances.createdAt })
            .from(remittances)
            .where(
              and(
                eq(remittances.clientId, c.clientId),
                eq(remittances.payerName, p.r.payer.name),
                eq(remittances.traceNumber, p.r.payment.traceNumber),
                eq(remittances.paymentAmountCents, p.r.payment.amountCents),
                eq(remittances.paymentDate, p.r.payment.paymentDate),
              ),
            ),
        )
      : [];
    payments.push({
      key: p.key,
      fileName: p.fileName,
      payerName: p.r.payer.name,
      traceNumber: p.r.payment.traceNumber,
      paymentDate: p.r.payment.paymentDate,
      claims: p.r.claims.length,
      amountCents: p.r.payment.amountCents,
      balanced: remit.balance835(p.r).balanced,
      clientId: c?.clientId ?? null,
      clientName: c?.clientName ?? null,
      importedOn: prior
        ? formatDate(prior.createdAt.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }))
        : null,
    });
  }
  return { ok: true, payments };
}

export interface ImportResult {
  ok: boolean;
  message: string;
}

export async function importUpload(form: FormData): Promise<ImportResult> {
  const ctx = await requireActiveContext();
  if (!policy.authorize(ctx.actor, 'payment.post').allowed)
    return { ok: false, message: 'Your role cannot import payments.' };
  const keep = new Set(form.getAll('keep').map(String));
  const files = await readFiles(form);
  if (!files.ok) return files;
  const clientOf = await clientsFor(ctx, files.parsed);
  let imported = 0;
  let skipped = 0;
  let attention = 0;
  for (const p of files.parsed.filter((x) => keep.has(x.key))) {
    const c = clientOf(p.r.payee.npi);
    if (!c) {
      skipped++;
      continue;
    }
    policy.assertAllowed(ctx.actor, 'payment.post', { clientId: c.clientId });
    const res = await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
      const actor = `user:${ctx.user.id}` as const;
      const out = await ingestInTx(
        tx,
        { tenantId: ctx.tenantId, clientId: c.clientId, source: 'file', actor },
        p.r,
        clockNow(),
      );
      if (out.status === 'ingested')
        await verifyInTx(tx, { tenantId: ctx.tenantId, clientId: c.clientId }, clockNow());
      return out;
    });
    if (res.status === 'duplicate') skipped++;
    else {
      imported++;
      if (res.status === 'out_of_balance' || (res.status === 'ingested' && res.unmatched)) attention++;
    }
    log.info({ remittanceId: res.remittanceId, status: res.status }, '835 uploaded');
  }
  revalidatePath('/remittances');
  revalidatePath('/work');
  if (!imported)
    return {
      ok: false,
      message: skipped ? 'Nothing new to import: those payments are already in.' : 'Nothing was imported.',
    };
  return {
    ok: true,
    message: `Imported ${imported} ${imported === 1 ? 'payment' : 'payments'}${skipped ? `, skipped ${skipped}` : ''}${attention ? `; ${attention} need attention` : ''}.`,
  };
}

/** W-18 / R-06: accept the difference on an 835 that does not balance (admins, with a reason). */
export async function acceptDifferenceAction(remittanceId: string, reason: string): Promise<ImportResult> {
  const ctx = await requireActiveContext();
  const id = z.uuid().parse(remittanceId);
  const why = reason.trim();
  if (why.length < 5) return { ok: false, message: 'Say why the difference is acceptable.' };
  const [r] = await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, (tx) =>
    tx.select({ clientId: remittances.clientId }).from(remittances).where(eq(remittances.id, id)),
  );
  if (!r) return { ok: false, message: 'Remittance not found.' };
  if (!policy.authorize(ctx.actor, 'remittance.accept_difference', { clientId: r.clientId }).allowed)
    return { ok: false, message: 'Only an admin can accept a difference.' };
  const res = await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, (tx) =>
    acceptDifference(
      tx,
      { tenantId: ctx.tenantId, userId: ctx.user.id },
      { remittanceId: id, reason: why.slice(0, 300) },
    ),
  );
  revalidatePath(`/remittances/${id}`);
  revalidatePath('/remittances');
  revalidatePath('/work');
  if (!res.ok) return { ok: false, message: 'This remittance is no longer out of balance.' };
  log.info({ remittanceId: id, matched: res.matched, setAside: res.setAside }, 'difference accepted');
  return {
    ok: true,
    message: `Accepted. ${res.matched} matched${res.setAside ? `, ${res.setAside} set aside because ${res.setAside === 1 ? 'it does' : 'they do'} not balance` : ''}${res.unmatched ? `, ${res.unmatched} to link` : ''}.`,
  };
}
