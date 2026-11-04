'use server';
/**
 * CL-02 / CL-08: pause and resume a client, and record its onboarding baseline. Admins only;
 * audited. Resume queues what waited: releases of ready claims and PM corrections.
 */
import { revalidatePath } from 'next/cache';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { pauseClient, resumeClient } from '@cleanpost/claims';
import { now as clockNow } from '@cleanpost/clock';
import {
  clientPayerSettings,
  clients,
  locations,
  memberships,
  providers,
  recordAudit,
  withTenant,
} from '@cleanpost/db';
import { baselineInputSchema, isValidNpi, policy, state } from '@cleanpost/domain';
import { sendClaimCorrect, sendClaimRelease } from '@cleanpost/jobs';
import { createLogger } from '@cleanpost/log';
import { mappingInputSchema, resetClientMapping, saveMapping } from '@cleanpost/remit';
import { getBoss } from '@/lib/jobs';
import { getDb } from '@/lib/server';
import { requireActiveContext } from '@/lib/session';

const log = createLogger({ name: 'web-clients' });

export interface ClientActionResult {
  ok: boolean;
  message: string;
}

async function admin(clientId: string) {
  const ctx = await requireActiveContext();
  policy.assertAllowed(ctx.actor, 'client.manage', { clientId });
  return ctx;
}

const PauseInput = z.object({
  reason: z.enum(state.PAUSE_REASONS),
  note: z.string().trim().max(500).nullable(),
  resumeOn: z.iso.date().nullable(),
});

export async function pauseClientAction(
  clientId: string,
  input: z.infer<typeof PauseInput>,
): Promise<ClientActionResult> {
  const id = z.uuid().parse(clientId);
  const ctx = await admin(id);
  const res = await pauseClient(
    getDb(),
    { tenantId: ctx.tenantId, userId: ctx.user.id },
    id,
    PauseInput.parse(input),
    clockNow(),
  );
  revalidatePath(`/clients/${id}`);
  if (!res.ok)
    return {
      ok: false,
      message:
        res.reason === 'note_required'
          ? 'Add a note to say why.'
          : res.reason === 'invalid_state'
            ? 'Only a live client can be paused.'
            : 'That client is not in this company.',
    };
  return { ok: true, message: 'Paused. Syncing continues; nothing is sent to payers or written to the PM.' };
}

export async function resumeClientAction(clientId: string): Promise<ClientActionResult> {
  const id = z.uuid().parse(clientId);
  const ctx = await admin(id);
  const res = await resumeClient(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, id, clockNow());
  revalidatePath(`/clients/${id}`);
  if (!res.ok) return { ok: false, message: 'Only a paused client can be resumed.' };
  const boss = await getBoss();
  for (const claimId of res.toRelease) await sendClaimRelease(boss, { tenantId: ctx.tenantId, claimId });
  for (const c of res.toCorrect) await sendClaimCorrect(boss, { tenantId: ctx.tenantId, ...c });
  log.info({ released: res.toRelease.length, corrections: res.toCorrect.length }, 'client resumed');
  const waited = res.toRelease.length + res.toCorrect.length;
  return {
    ok: true,
    message: waited
      ? `Resumed. ${waited === 1 ? 'One claim that waited is' : `${waited} claims that waited are`} going out now.`
      : 'Resumed.',
  };
}

/** The practice's figures before Cleanpost, from its own reports (totals only). */
export async function saveBaselineAction(
  clientId: string,
  input: z.input<typeof baselineInputSchema>,
): Promise<ClientActionResult> {
  const id = z.uuid().parse(clientId);
  const ctx = await admin(id);
  const parsed = baselineInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'Check the figures: rates are percents from 0 to 100.' };
  const b = parsed.data;
  if (b.collectionsCents === null && b.firstPass === null && b.denialRate === null && b.daysInAr === null)
    return { ok: false, message: 'Enter at least one figure.' };
  const ok = await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const [c] = await tx.select({ id: clients.id }).from(clients).where(eq(clients.id, id));
    if (!c) return false;
    await tx
      .update(clients)
      .set({ baseline: { ...b, recordedAt: clockNow().toISOString(), recordedBy: `user:${ctx.user.id}` } })
      .where(eq(clients.id, id));
    await recordAudit(tx, {
      actor: `user:${ctx.user.id}`,
      action: 'client.baseline_recorded',
      entityType: 'client',
      entityId: id,
      clientId: id,
      metadata: {
        figures: ['collectionsCents', 'firstPass', 'denialRate', 'daysInAr'].filter(
          (k) => b[k as keyof typeof b] !== null,
        ),
      },
    });
    return true;
  });
  revalidatePath(`/clients/${id}`);
  revalidatePath(`/reports/clients/${id}`);
  return ok
    ? { ok: true, message: 'Baseline saved. Reports compare against it from now on.' }
    : { ok: false, message: 'That client is not in this company.' };
}

/* CL-03 Client settings ------------------------------------------------------------------------- */

const TIME_ZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
] as const;

const SettingsInput = z.object({
  /** null: the company default; 100: review everything. */
  threshold: z.number().int().min(0).max(100).nullable(),
  reviewUntil: z.iso.date().nullable(),
  pmBatchTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .nullable(),
  timezone: z.enum(TIME_ZONES),
  primaryBillerId: z.uuid().nullable(),
  backupBillerId: z.uuid().nullable(),
});

/** CL-03: threshold, review-everything date, PM batch time, time zone, primary and backup biller. */
export async function saveClientSettingsAction(
  clientId: string,
  input: z.input<typeof SettingsInput>,
): Promise<ClientActionResult> {
  const id = z.uuid().parse(clientId);
  const ctx = await admin(id);
  const parsed = SettingsInput.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'Check the settings and try again.' };
  const v = parsed.data;
  if (v.primaryBillerId && v.primaryBillerId === v.backupBillerId)
    return { ok: false, message: 'Choose a different person as backup.' };
  const res = await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const [c] = await tx.select().from(clients).where(eq(clients.id, id)).for('update');
    if (!c) return { ok: false, message: 'That client is not in this company.' };
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: v.timezone }).format(clockNow());
    if (v.reviewUntil && v.reviewUntil < today && v.reviewUntil !== c.reviewUntil)
      return { ok: false, message: 'Pick a review-everything date from today on.' };
    // Primary and backup must be people in this company who can see the client.
    for (const who of [v.primaryBillerId, v.backupBillerId].filter((x): x is string => Boolean(x))) {
      const [m] = await tx
        .select({ role: memberships.role, scope: memberships.clientScope, ids: memberships.clientIds })
        .from(memberships)
        .where(and(eq(memberships.userId, who), eq(memberships.status, 'active')));
      if (!m || m.role === 'viewer' || (m.role === 'biller' && m.scope !== 'all' && !m.ids.includes(id)))
        return { ok: false, message: 'The primary and backup biller must be able to work this client.' };
    }
    const before = {
      threshold: c.autoReleaseThreshold,
      reviewUntil: c.reviewUntil,
      pmBatchTime: c.pmBatchTime ? c.pmBatchTime.slice(0, 5) : null,
      timezone: c.timezone,
      primaryBillerId: c.primaryBillerId,
      backupBillerId: c.backupBillerId,
    };
    const after = { ...v };
    const changed = (Object.keys(before) as (keyof typeof before)[]).filter((k) => before[k] !== after[k]);
    if (!changed.length) return { ok: true, message: 'Nothing to save.' };
    await tx
      .update(clients)
      .set({
        autoReleaseThreshold: v.threshold,
        reviewUntil: v.reviewUntil,
        pmBatchTime: v.pmBatchTime ? `${v.pmBatchTime}:00` : null,
        timezone: v.timezone,
        primaryBillerId: v.primaryBillerId,
        backupBillerId: v.backupBillerId,
        updatedAt: clockNow(),
      })
      .where(eq(clients.id, id));
    await recordAudit(tx, {
      actor: `user:${ctx.user.id}`,
      action: 'client.settings_changed',
      entityType: 'client',
      entityId: id,
      clientId: id,
      metadata: Object.fromEntries(
        changed.map((k) => [k, { from: before[k] ?? 'none', to: after[k] ?? 'none' }]),
      ),
    });
    return {
      ok: true,
      message: `Saved ${changed.length === 1 ? 'one change' : `${changed.length} changes`}. Threshold changes apply to claims scrubbed from now on.`,
    };
  });
  revalidatePath(`/clients/${id}`, 'layout');
  return res;
}

/* CL-04 Providers and locations ----------------------------------------------------------------- */

const ProviderInput = z.object({
  npi: z.string().regex(/^\d{10}$/),
  name: z.string().trim().min(2).max(120),
  taxonomy: z
    .string()
    .trim()
    .regex(/^[0-9A-Z]{9}X$/)
    .nullable(),
  role: z.enum(['rendering', 'billing', 'referring']),
});

/** Add a provider (providerId null) or change one. NPIs pass the check digit first. */
export async function saveProviderAction(
  clientId: string,
  providerId: string | null,
  input: z.input<typeof ProviderInput>,
): Promise<ClientActionResult> {
  const id = z.uuid().parse(clientId);
  const ctx = await admin(id);
  const parsed = ProviderInput.safeParse({
    ...input,
    taxonomy: input.taxonomy?.trim().toUpperCase() || null,
  });
  if (!parsed.success)
    return { ok: false, message: 'Enter a 10-digit NPI, a name, and a taxonomy like 207Q00000X (or none).' };
  const v = parsed.data;
  if (!isValidNpi(v.npi)) return { ok: false, message: 'That NPI fails its check digit. Check the number.' };
  return withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const [dup] = await tx
      .select({ id: providers.id })
      .from(providers)
      .where(and(eq(providers.clientId, id), eq(providers.npi, v.npi)));
    if (dup && dup.id !== providerId)
      return { ok: false, message: 'This client already has a provider with that NPI.' };
    let rowId = providerId;
    if (providerId) {
      const [row] = await tx
        .update(providers)
        .set({ ...v, updatedAt: clockNow() })
        .where(and(eq(providers.id, providerId), eq(providers.clientId, id)))
        .returning({ id: providers.id });
      if (!row) return { ok: false, message: 'That provider is not on this client.' };
    } else {
      const [row] = await tx
        .insert(providers)
        .values({ tenantId: ctx.tenantId, clientId: id, ...v })
        .returning({ id: providers.id });
      rowId = row!.id;
    }
    await recordAudit(tx, {
      actor: `user:${ctx.user.id}`,
      action: providerId ? 'provider.updated' : 'provider.added',
      entityType: 'provider',
      entityId: rowId,
      clientId: id,
      metadata: { role: v.role },
    });
    revalidatePath(`/clients/${id}/providers`);
    return {
      ok: true,
      message: providerId ? 'Provider saved. Claims built from now on use it.' : 'Provider added.',
    };
  });
}

const LocationInput = z.object({
  name: z.string().trim().min(2).max(120),
  line1: z.string().trim().max(120),
  city: z.string().trim().max(60),
  state: z
    .string()
    .trim()
    .regex(/^[A-Z]{2}$/),
  zip: z
    .string()
    .trim()
    .regex(/^\d{5}(-\d{4})?$/),
  placeOfService: z.string().regex(/^\d{2}$/),
  npi: z
    .string()
    .regex(/^\d{10}$/)
    .nullable(),
});

export async function saveLocationAction(
  clientId: string,
  locationId: string | null,
  input: z.input<typeof LocationInput>,
): Promise<ClientActionResult> {
  const id = z.uuid().parse(clientId);
  const ctx = await admin(id);
  const parsed = LocationInput.safeParse({
    ...input,
    state: input.state.trim().toUpperCase(),
    npi: input.npi?.trim() || null,
  });
  if (!parsed.success)
    return {
      ok: false,
      message: 'Enter a name, a street, city, two-letter state, ZIP and a two-digit place of service.',
    };
  const v = parsed.data;
  if (v.npi && !isValidNpi(v.npi))
    return { ok: false, message: 'That NPI fails its check digit. Check the number.' };
  const values = {
    name: v.name,
    address: { line1: v.line1, city: v.city, state: v.state, zip: v.zip },
    placeOfService: v.placeOfService,
    npi: v.npi,
  };
  return withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    let rowId = locationId;
    if (locationId) {
      const [row] = await tx
        .update(locations)
        .set({ ...values, updatedAt: clockNow() })
        .where(and(eq(locations.id, locationId), eq(locations.clientId, id)))
        .returning({ id: locations.id });
      if (!row) return { ok: false, message: 'That location is not on this client.' };
    } else {
      const [row] = await tx
        .insert(locations)
        .values({ tenantId: ctx.tenantId, clientId: id, ...values })
        .returning({ id: locations.id });
      rowId = row!.id;
    }
    await recordAudit(tx, {
      actor: `user:${ctx.user.id}`,
      action: locationId ? 'location.updated' : 'location.added',
      entityType: 'location',
      entityId: rowId,
      clientId: id,
      metadata: { placeOfService: v.placeOfService },
    });
    revalidatePath(`/clients/${id}/providers`);
    return { ok: true, message: locationId ? 'Location saved.' : 'Location added.' };
  });
}

/* CL-05 Payers and CL-06 mappings --------------------------------------------------------------- */

/** CL-05: the timely filing limit for one of the client's payers (days from the date of service). */
export async function savePayerSettingsAction(
  clientId: string,
  settingsId: string,
  timelyFilingDays: number,
): Promise<ClientActionResult> {
  const id = z.uuid().parse(clientId);
  const ctx = await admin(id);
  const days = z.number().int().min(30).max(730).safeParse(timelyFilingDays);
  if (!days.success) return { ok: false, message: 'Use a number of days from 30 to 730.' };
  return withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const [s] = await tx
      .select()
      .from(clientPayerSettings)
      .where(
        and(eq(clientPayerSettings.id, z.uuid().parse(settingsId)), eq(clientPayerSettings.clientId, id)),
      )
      .for('update');
    if (!s) return { ok: false, message: 'That payer is not set up for this client.' };
    if (s.timelyFilingDays === days.data) return { ok: true, message: 'Nothing to save.' };
    await tx
      .update(clientPayerSettings)
      .set({ timelyFilingDays: days.data, updatedAt: clockNow() })
      .where(eq(clientPayerSettings.id, s.id));
    await recordAudit(tx, {
      actor: `user:${ctx.user.id}`,
      action: 'client_payer.updated',
      entityType: 'client_payer',
      entityId: s.id,
      clientId: id,
      metadata: { timelyFilingDays: { from: s.timelyFilingDays, to: days.data } },
    });
    revalidatePath(`/clients/${id}/payers`);
    return {
      ok: true,
      message: `Timely filing set to ${days.data} days. Follow-ups and deadlines use it from now on.`,
    };
  });
}

/** CL-06: this client's own mapping for a code (an override of the company's). */
export async function saveClientMappingAction(
  clientId: string,
  input: { groupCode: string; carc: string; pmAdjustmentCode: string; action: string },
): Promise<ClientActionResult> {
  const id = z.uuid().parse(clientId);
  const ctx = await requireActiveContext();
  policy.assertAllowed(ctx.actor, 'mappings.manage', { clientId: id });
  const parsed = mappingInputSchema.safeParse({ ...input, clientId: id, scope: 'client' });
  if (!parsed.success)
    return { ok: false, message: 'Enter the PM code (letters and numbers) and choose what it does.' };
  const res = await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, (tx) =>
    saveMapping(tx, { tenantId: ctx.tenantId, userId: ctx.user.id }, parsed.data),
  );
  revalidatePath(`/clients/${id}/mappings`);
  const pair = `${parsed.data.groupCode}-${parsed.data.carc}`;
  if (!res.ok)
    return {
      ok: false,
      message:
        res.reason === 'denial_code'
          ? `${pair} is a denial: the balance stays open for the denial queue, so it is never mapped.`
          : 'This client has no PM connection to map codes for.',
    };
  return { ok: true, message: `Saved ${pair} for this client; its payments are checked again.` };
}

export async function resetClientMappingAction(
  clientId: string,
  groupCode: string,
  carc: string,
): Promise<ClientActionResult> {
  const id = z.uuid().parse(clientId);
  const ctx = await requireActiveContext();
  policy.assertAllowed(ctx.actor, 'mappings.manage', { clientId: id });
  const res = await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, (tx) =>
    resetClientMapping(
      tx,
      { tenantId: ctx.tenantId, userId: ctx.user.id },
      { clientId: id, groupCode, carc },
    ),
  );
  revalidatePath(`/clients/${id}/mappings`);
  return res.ok
    ? { ok: true, message: `${groupCode}-${carc} follows the company mapping again.` }
    : { ok: false, message: 'This client has no mapping of its own for that code.' };
}
