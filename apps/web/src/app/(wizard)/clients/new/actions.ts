'use server';
/**
 * O-01 to O-10 onboarding wizard: each step saves as it goes (`clients.onboarding` holds the
 * progress, counts and names only), and Go live checks the whole checklist again on the server.
 * Admins only; every change is audited. The PM is reached only through the worker's jobs (test,
 * dry run, first sync) and, in local and preview, the mock PM's admin API that makes the practice.
 */
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { PROFILES } from '@cleanpost/adapters';
import { now as clockNow } from '@cleanpost/clock';
import {
  clientPayerSettings,
  clients,
  connections,
  encryptField,
  externalRefs,
  last4,
  locations,
  memberships,
  payers,
  providers,
  recordAudit,
  tenants,
  users,
  withTenant,
  type Tx,
} from '@cleanpost/db';
import { isValidNpi, policy, readOnboarding, stepIndex, type OnboardingState } from '@cleanpost/domain';
import { clientLiveEmail } from '@cleanpost/email';
import { sendConnectionTest, sendOnboardingDryRun, sendSyncPull } from '@cleanpost/jobs';
import { createLogger } from '@cleanpost/log';
import { goLive } from '@cleanpost/sync';
import { authEnvSchema, parseEnv } from '@cleanpost/config';
import { getBoss } from '@/lib/jobs';
import { DEMO_PM_PAYERS, REVIEW_EVERYTHING_DAYS, TIME_ZONE_IDS, pmChoice } from '@/lib/onboarding/options';
import { createMockPractice, mockPmAvailable } from '@/lib/onboarding/pm-mock';
import { checklistFor, onboardingClient } from '@/lib/queries/onboarding';
import { getDb, getMailer } from '@/lib/server';
import { requireActiveContext, type ActiveContext } from '@/lib/session';

const log = createLogger({ name: 'web-onboarding' });

export interface WizardResult {
  ok: boolean;
  message: string;
  /** Where the wizard goes next, when the step moved on. */
  next?: string;
  clientId?: string;
}

const stepHref = (key: string, clientId: string) => `/clients/new/${key}?client=${clientId}`;

async function adminFor(clientId: string): Promise<ActiveContext> {
  const ctx = await requireActiveContext();
  policy.assertAllowed(ctx.actor, 'client.manage', { clientId });
  return ctx;
}

const actorOf = (ctx: ActiveContext) => `user:${ctx.user.id}` as const;
const scope = (ctx: ActiveContext) => ({ tenantId: ctx.tenantId, userId: ctx.user.id });

type ClientRow = typeof clients.$inferSelect;
type Locked = { c: ClientRow; s: OnboardingState };

/** The client, locked, while it is still onboarding; null otherwise. */
async function lockOnboarding(tx: Tx, clientId: string): Promise<Locked | null> {
  const [c] = await tx.select().from(clients).where(eq(clients.id, clientId)).for('update');
  if (!c || c.status !== 'onboarding') return null;
  return { c, s: readOnboarding(c.onboarding) };
}

/** Save progress; `reached` is the step number now open (furthest wins). */
async function saveState(tx: Tx, l: Locked, patch: Partial<OnboardingState>, reached?: number) {
  const s: OnboardingState = { ...l.s, ...patch, step: Math.max(l.s.step, reached ?? l.s.step) };
  await tx.update(clients).set({ onboarding: s, updatedAt: clockNow() }).where(eq(clients.id, l.c.id));
  return s;
}

const NOT_ONBOARDING: WizardResult = {
  ok: false,
  message: 'This client is not being onboarded any more. Open it from Clients.',
};

/** Step number (1 to 10) of the step after `key`. */
const after = (key: string) => stepIndex(key) + 2;

/* O-01 Practice ---------------------------------------------------------------------------------- */

const PracticeInput = z.object({
  name: z.string().trim().min(2).max(120),
  billingNpi: z.string().regex(/^\d{10}$/),
  /** Blank on a later save keeps the stored value. */
  taxId: z
    .string()
    .trim()
    .regex(/^\d{2}-?\d{7}$/)
    .nullable(),
  taxonomy: z
    .string()
    .trim()
    .regex(/^[0-9A-Z]{9}X$/)
    .nullable(),
  line1: z.string().trim().min(3).max(120),
  city: z.string().trim().min(2).max(60),
  state: z.string().regex(/^[A-Z]{2}$/),
  zip: z.string().regex(/^\d{5}(-\d{4})?$/),
  timezone: z.enum(TIME_ZONE_IDS),
  contact: z.string().trim().max(120).nullable(),
});
export type PracticeInputValues = z.input<typeof PracticeInput>;

/** Create the client (clientId null) or update its practice details; moves on to O-02. */
export async function savePracticeAction(
  clientId: string | null,
  input: PracticeInputValues,
): Promise<WizardResult> {
  const ctx = await requireActiveContext();
  const id = clientId ? z.uuid().parse(clientId) : null;
  policy.assertAllowed(ctx.actor, id ? 'client.manage' : 'client.create', id ? { clientId: id } : {});
  const parsed = PracticeInput.safeParse({
    ...input,
    taxId: input.taxId?.trim() || null,
    taxonomy: input.taxonomy?.trim().toUpperCase() || null,
    state: input.state.trim().toUpperCase(),
    zip: input.zip.trim(),
    contact: input.contact?.trim() || null,
  });
  if (!parsed.success)
    return {
      ok: false,
      message:
        'Check the highlighted details: a 10-digit NPI, a tax ID like 93-4418207, a street, city, two-letter state and ZIP.',
    };
  const v = parsed.data;
  if (!isValidNpi(v.billingNpi))
    return { ok: false, message: 'That billing NPI fails its check digit. Check the number.' };
  if (!id && !v.taxId) return { ok: false, message: 'Enter the practice’s tax ID (EIN).' };
  const taxId = v.taxId
    ? `${v.taxId.replace('-', '').slice(0, 2)}-${v.taxId.replace('-', '').slice(2)}`
    : null;
  const details = {
    name: v.name,
    billingNpi: v.billingNpi,
    taxonomy: v.taxonomy,
    address: { line1: v.line1, city: v.city, state: v.state, zip: v.zip },
    timezone: v.timezone,
  };
  return withTenant(getDb(), scope(ctx), async (tx) => {
    if (!id) {
      const [row] = await tx
        .insert(clients)
        .values({
          tenantId: ctx.tenantId,
          ...details,
          taxIdEncrypted: encryptField(taxId!),
          status: 'onboarding',
          onboarding: {
            step: 2,
            taxIdLast4: last4(taxId!),
            ...(v.contact ? { contact: v.contact } : {}),
          } satisfies OnboardingState,
        })
        .returning({ id: clients.id });
      await recordAudit(tx, {
        actor: actorOf(ctx),
        action: 'client.created',
        entityType: 'client',
        entityId: row!.id,
        clientId: row!.id,
        metadata: { via: 'onboarding' },
      });
      return {
        ok: true,
        message: 'Saved.',
        clientId: row!.id,
        next: stepHref('providers', row!.id),
      };
    }
    const l = await lockOnboarding(tx, id);
    if (!l) return NOT_ONBOARDING;
    await tx
      .update(clients)
      .set({ ...details, ...(taxId ? { taxIdEncrypted: encryptField(taxId) } : {}), updatedAt: clockNow() })
      .where(eq(clients.id, id));
    await saveState(
      tx,
      l,
      {
        ...(taxId ? { taxIdLast4: last4(taxId) } : {}),
        ...(v.contact ? { contact: v.contact } : { contact: undefined }),
      },
      2,
    );
    await recordAudit(tx, {
      actor: actorOf(ctx),
      action: 'client.practice_updated',
      entityType: 'client',
      entityId: id,
      clientId: id,
      metadata: { taxIdChanged: Boolean(taxId) },
    });
    return { ok: true, message: 'Saved.', clientId: id, next: stepHref('providers', id) };
  });
}

/* O-02 Providers and locations ------------------------------------------------------------------- */

/** While onboarding nothing refers to them yet, so a wrong provider or location can be removed. */
export async function removeSetupRowAction(
  clientId: string,
  kind: 'provider' | 'location',
  rowId: string,
): Promise<WizardResult> {
  const id = z.uuid().parse(clientId);
  const ctx = await adminFor(id);
  const row = z.uuid().parse(rowId);
  return withTenant(getDb(), scope(ctx), async (tx) => {
    const l = await lockOnboarding(tx, id);
    if (!l) return NOT_ONBOARDING;
    if (kind === 'provider') {
      const del = await tx
        .delete(providers)
        .where(and(eq(providers.id, row), eq(providers.clientId, id)))
        .returning({ id: providers.id });
      if (!del.length) return { ok: false, message: 'That provider is not on this client.' };
    } else {
      await tx
        .delete(externalRefs)
        .where(
          and(
            eq(externalRefs.clientId, id),
            eq(externalRefs.entityType, 'location'),
            eq(externalRefs.entityId, row),
          ),
        );
      const del = await tx
        .delete(locations)
        .where(and(eq(locations.id, row), eq(locations.clientId, id)))
        .returning({ id: locations.id });
      if (!del.length) return { ok: false, message: 'That location is not on this client.' };
    }
    await recordAudit(tx, {
      actor: actorOf(ctx),
      action: kind === 'provider' ? 'provider.removed' : 'location.removed',
      entityType: kind,
      entityId: row,
      clientId: id,
      metadata: { during: 'onboarding' },
    });
    return { ok: true, message: kind === 'provider' ? 'Provider removed.' : 'Location removed.' };
  });
}

export async function continueProvidersAction(clientId: string): Promise<WizardResult> {
  const id = z.uuid().parse(clientId);
  const ctx = await adminFor(id);
  return withTenant(getDb(), scope(ctx), async (tx) => {
    const l = await lockOnboarding(tx, id);
    if (!l) return NOT_ONBOARDING;
    const [p] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(providers)
      .where(and(eq(providers.clientId, id), eq(providers.role, 'rendering')));
    const [loc] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(locations)
      .where(eq(locations.clientId, id));
    if (!p?.n) return { ok: false, message: 'Add at least one rendering provider.' };
    if (!loc?.n) return { ok: false, message: 'Add at least one location.' };
    await saveState(tx, l, {}, after('providers'));
    return { ok: true, message: 'Saved.', next: stepHref('pm', id) };
  });
}

/* O-03 PM system --------------------------------------------------------------------------------- */

/** Choosing never connects anything. Choosing again before a test passes starts the connection over. */
export async function choosePmAction(
  clientId: string,
  choiceKey: string,
  otherName: string | null,
): Promise<WizardResult> {
  const id = z.uuid().parse(clientId);
  const ctx = await adminFor(id);
  const choice = pmChoice(choiceKey);
  if (!choice) return { ok: false, message: 'Choose a PM system.' };
  if (choice.demo && !mockPmAvailable())
    return { ok: false, message: `${choice.pmName} connects only where the demo PM runs.` };
  const name =
    choice.key === 'manual'
      ? (z.string().trim().min(2).max(60).safeParse(otherName).data ?? null)
      : choice.pmName;
  if (!name) return { ok: false, message: 'Enter the name of the PM system.' };
  return withTenant(getDb(), scope(ctx), async (tx) => {
    const l = await lockOnboarding(tx, id);
    if (!l) return NOT_ONBOARDING;
    const same =
      l.s.pm?.adapterKey === choice.adapterKey && l.s.pm.profile === choice.profile && l.s.pm.pmName === name;
    if (!same) {
      const [conn] = await tx.select().from(connections).where(eq(connections.clientId, id)).limit(1);
      if (conn && conn.status !== 'setup')
        return { ok: false, message: 'This client is already connected. Change the PM from Integrations.' };
      if (conn) {
        await tx.delete(externalRefs).where(eq(externalRefs.connectionId, conn.id));
        await tx.delete(connections).where(eq(connections.id, conn.id));
      }
    }
    await saveState(
      tx,
      l,
      same
        ? {}
        : {
            pm: { adapterKey: choice.adapterKey, profile: choice.profile, pmName: name },
            test: undefined,
            testRequestedAt: undefined,
            dryRun: undefined,
            dryRunRequestedAt: undefined,
            dryRunConfirmed: false,
            postingReviewed: false,
          },
      after('pm'),
    );
    if (!same)
      await recordAudit(tx, {
        actor: actorOf(ctx),
        action: 'client.pm_chosen',
        entityType: 'client',
        entityId: id,
        clientId: id,
        metadata: { adapterKey: choice.adapterKey, profile: choice.profile },
      });
    return { ok: true, message: 'Saved.', next: stepHref('connect', id) };
  });
}

/* O-04 Connect ----------------------------------------------------------------------------------- */

/**
 * Make the connection and test it. For a demo PM, the practice is created in the mock PM with this
 * client's providers and locations (synthetic patients and charges), and the PM's locations are
 * mapped to the client's. A manual connection has nothing to test.
 */
export async function connectAction(clientId: string): Promise<WizardResult> {
  const id = z.uuid().parse(clientId);
  const ctx = await adminFor(id);
  const db = getDb();
  const prep = await withTenant(db, scope(ctx), async (tx) => {
    const l = await lockOnboarding(tx, id);
    if (!l) return null;
    const [conn] = await tx.select().from(connections).where(eq(connections.clientId, id)).limit(1);
    const provs = await tx
      .select({ npi: providers.npi, name: providers.name })
      .from(providers)
      .where(and(eq(providers.clientId, id), eq(providers.role, 'rendering')));
    const locs = await tx
      .select({ id: locations.id, name: locations.name, pos: locations.placeOfService })
      .from(locations)
      .where(eq(locations.clientId, id))
      .orderBy(locations.createdAt);
    return { l, conn, provs, locs };
  });
  if (!prep) return NOT_ONBOARDING;
  const { l, provs, locs } = prep;
  let conn = prep.conn;
  const pm = l.s.pm;
  if (!pm) return { ok: false, message: 'Choose the PM system first.', next: stepHref('pm', id) };
  if (pm.adapterKey !== 'mock' && pm.adapterKey !== 'manual')
    return {
      ok: false,
      message: `${pm.pmName} cannot be connected here yet. Choose another PM, or “My PM is not listed”.`,
    };

  if (!conn) {
    if (pm.adapterKey === 'manual') {
      conn = await withTenant(db, scope(ctx), async (tx) => {
        const [row] = await tx
          .insert(connections)
          .values({
            tenantId: ctx.tenantId,
            clientId: id,
            adapterKey: 'manual',
            levels: PROFILES.manual,
            settings: { pmName: pm.pmName, profile: 'manual' },
            status: 'setup',
          })
          .returning();
        await recordAudit(tx, {
          actor: actorOf(ctx),
          action: 'connection.created',
          entityType: 'connection',
          entityId: row!.id,
          clientId: id,
          metadata: { adapterKey: 'manual' },
        });
        return row!;
      });
    } else {
      if (!mockPmAvailable()) return { ok: false, message: 'The demo PM is not running here.' };
      if (!provs.length || !locs.length)
        return { ok: false, message: 'Add providers and locations first.', next: stepHref('providers', id) };
      let made: Awaited<ReturnType<typeof createMockPractice>>;
      try {
        made = await createMockPractice({
          name: l.c.name,
          profile: pm.profile === 'tebra' ? 'tebra' : 'managed_api',
          providers: provs,
          locations: locs.map((x) => ({ name: x.name, placeOfService: x.pos })),
          payers: DEMO_PM_PAYERS.map((p) => ({ name: p.name, kind: p.kind })),
        });
      } catch (err) {
        log.warn(
          { clientId: id, code: (err as { code?: string }).code ?? 'unknown' },
          'mock practice failed',
        );
        return { ok: false, message: `${pm.pmName} did not answer. Try again in a moment.` };
      }
      conn = await withTenant(db, scope(ctx), async (tx) => {
        const [row] = await tx
          .insert(connections)
          .values({
            tenantId: ctx.tenantId,
            clientId: id,
            adapterKey: 'mock',
            levels: PROFILES[pm.profile === 'tebra' ? 'tebra' : 'managed_api'],
            credentialsSecretRef: `pm-mock:${made.accountId}`,
            syncIntervalMinutes: pm.profile === 'tebra' ? 120 : null,
            settings: { pmName: pm.pmName, profile: pm.profile, practiceId: made.practiceId },
            status: 'setup',
          })
          .returning();
        // The PM's locations, in the order they were made, are the client's locations.
        for (const [i, loc] of made.locations.entries()) {
          const mine = locs[i];
          if (!mine) continue;
          await tx
            .insert(externalRefs)
            .values({
              tenantId: ctx.tenantId,
              clientId: id,
              connectionId: row!.id,
              entityType: 'location',
              entityId: mine.id,
              externalId: loc.id,
            })
            .onConflictDoNothing();
        }
        await recordAudit(tx, {
          actor: actorOf(ctx),
          action: 'connection.created',
          entityType: 'connection',
          entityId: row!.id,
          clientId: id,
          metadata: { adapterKey: 'mock', profile: pm.profile },
        });
        return row!;
      });
    }
  }

  if (conn.adapterKey === 'manual') {
    await withTenant(db, scope(ctx), async (tx) => {
      const locked = await lockOnboarding(tx, id);
      if (locked)
        await saveState(tx, locked, {
          test: { ok: true, checkedAt: clockNow().toISOString(), details: { connection: 'manual' } },
        });
    });
    return { ok: true, message: 'Nothing to test: charges come by file. Continue when ready.' };
  }
  return requestTest(ctx, id, conn.id);
}

async function requestTest(
  ctx: ActiveContext,
  clientId: string,
  connectionId: string,
): Promise<WizardResult> {
  await withTenant(getDb(), scope(ctx), async (tx) => {
    const l = await lockOnboarding(tx, clientId);
    if (l) await saveState(tx, l, { testRequestedAt: clockNow().toISOString() });
  });
  await sendConnectionTest(await getBoss(), { tenantId: ctx.tenantId, connectionId, userId: ctx.user.id });
  return { ok: true, message: 'Testing the connection…' };
}

export async function retestAction(clientId: string): Promise<WizardResult> {
  const id = z.uuid().parse(clientId);
  const ctx = await adminFor(id);
  const [conn] = await withTenant(getDb(), scope(ctx), (tx) =>
    tx.select().from(connections).where(eq(connections.clientId, id)).limit(1),
  );
  if (!conn) return connectAction(id);
  if (conn.adapterKey === 'manual') return { ok: true, message: 'Nothing to test.' };
  return requestTest(ctx, id, conn.id);
}

export async function continueConnectAction(clientId: string): Promise<WizardResult> {
  const id = z.uuid().parse(clientId);
  const ctx = await adminFor(id);
  return withTenant(getDb(), scope(ctx), async (tx) => {
    const l = await lockOnboarding(tx, id);
    if (!l) return NOT_ONBOARDING;
    if (!l.s.test?.ok) return { ok: false, message: 'Continue once the connection test passes.' };
    await saveState(tx, l, {}, after('connect'));
    return { ok: true, message: 'Saved.', next: stepHref('dry-run', id) };
  });
}

/* O-05 Dry run ----------------------------------------------------------------------------------- */

export async function runDryRunAction(clientId: string): Promise<WizardResult> {
  const id = z.uuid().parse(clientId);
  const ctx = await adminFor(id);
  const ok = await withTenant(getDb(), scope(ctx), async (tx) => {
    const l = await lockOnboarding(tx, id);
    if (!l || !l.s.test?.ok || l.s.pm?.adapterKey === 'manual') return false;
    await saveState(tx, l, { dryRunRequestedAt: clockNow().toISOString(), dryRunConfirmed: false });
    return true;
  });
  if (!ok) return { ok: false, message: 'Test the connection first.' };
  await sendOnboardingDryRun(await getBoss(), { tenantId: ctx.tenantId, clientId: id, userId: ctx.user.id });
  return { ok: true, message: 'Pulling the last 7 days…' };
}

/** Every sample has been compared with the PM (the IDs are the PM's encounter numbers). */
export async function confirmDryRunAction(clientId: string, checked: string[]): Promise<WizardResult> {
  const id = z.uuid().parse(clientId);
  const ctx = await adminFor(id);
  const ticks = new Set(z.array(z.string().max(80)).max(50).parse(checked));
  return withTenant(getDb(), scope(ctx), async (tx) => {
    const l = await lockOnboarding(tx, id);
    if (!l) return NOT_ONBOARDING;
    if (l.s.pm?.adapterKey !== 'manual') {
      const run = l.s.dryRun;
      if (!run) return { ok: false, message: 'Run the dry run first.' };
      if (run.samples.some((x) => !ticks.has(x.encounterId)))
        return { ok: false, message: 'Tick every sample once you have compared it with the PM.' };
      await recordAudit(tx, {
        actor: actorOf(ctx),
        action: 'client.dry_run_reviewed',
        entityType: 'client',
        entityId: id,
        clientId: id,
        metadata: { samples: run.samples.length, encounters: run.encounters },
      });
    }
    await saveState(tx, l, { dryRunConfirmed: true, dryRunCheckedBy: ctx.user.id }, after('dry-run'));
    return { ok: true, message: 'Saved.', next: stepHref('payers', id) };
  });
}

/* O-06 Payers ------------------------------------------------------------------------------------ */

const PayerRows = z
  .array(
    z.object({
      pmName: z.string().trim().min(1).max(120),
      payerId: z.uuid(),
      timelyFilingDays: z.number().int().min(30).max(730),
    }),
  )
  .min(1)
  .max(100);

/** The client's payers: one per payer, with the name the PM uses and the timely filing limit. */
export async function savePayersAction(
  clientId: string,
  rows: z.input<typeof PayerRows>,
): Promise<WizardResult> {
  const id = z.uuid().parse(clientId);
  const ctx = await adminFor(id);
  const parsed = PayerRows.safeParse(rows);
  if (!parsed.success)
    return { ok: false, message: 'Choose a payer for every name and use 30 to 730 days for timely filing.' };
  const v = parsed.data;
  const seen = new Set<string>();
  for (const r of v) {
    if (seen.has(r.payerId))
      return {
        ok: false,
        message: 'Two names point to the same payer. Choose a different payer for one of them.',
      };
    seen.add(r.payerId);
  }
  return withTenant(getDb(), scope(ctx), async (tx) => {
    const l = await lockOnboarding(tx, id);
    if (!l) return NOT_ONBOARDING;
    const known = await tx
      .select({ id: payers.id })
      .from(payers)
      .where(inArray(payers.id, [...seen]));
    if (known.length !== seen.size)
      return { ok: false, message: 'One of those payers is not in the payer list.' };
    // While onboarding, the list replaces what was there.
    await tx
      .delete(clientPayerSettings)
      .where(and(eq(clientPayerSettings.clientId, id), notInArray(clientPayerSettings.payerId, [...seen])));
    for (const r of v) {
      await tx
        .insert(clientPayerSettings)
        .values({
          tenantId: ctx.tenantId,
          clientId: id,
          payerId: r.payerId,
          pmPayerName: r.pmName,
          timelyFilingDays: r.timelyFilingDays,
          // Mode A: the PM's clearinghouse keeps the ERAs, so no enrollment with Stedi is needed.
          eraEnrollmentStatus: 'not_required',
          ediEnrollmentStatus: 'not_required',
        })
        .onConflictDoUpdate({
          target: [clientPayerSettings.clientId, clientPayerSettings.payerId],
          set: { pmPayerName: r.pmName, timelyFilingDays: r.timelyFilingDays, updatedAt: clockNow() },
        });
    }
    await saveState(tx, l, {}, after('payers'));
    await recordAudit(tx, {
      actor: actorOf(ctx),
      action: 'client.payers_set',
      entityType: 'client',
      entityId: id,
      clientId: id,
      metadata: { payers: v.length },
    });
    return { ok: true, message: 'Saved.', next: stepHref('mode', id) };
  });
}

/* O-07 Mode, O-08 Posting rules ------------------------------------------------------------------ */

export async function chooseModeAction(clientId: string, mode: string): Promise<WizardResult> {
  const id = z.uuid().parse(clientId);
  const ctx = await adminFor(id);
  if (mode !== 'A') return { ok: false, message: 'Modes B and C are not available yet.' };
  return withTenant(getDb(), scope(ctx), async (tx) => {
    const l = await lockOnboarding(tx, id);
    if (!l) return NOT_ONBOARDING;
    await tx.update(clients).set({ defaultMode: 'A', updatedAt: clockNow() }).where(eq(clients.id, id));
    await saveState(tx, l, { modeChosen: true }, after('mode'));
    await recordAudit(tx, {
      actor: actorOf(ctx),
      action: 'client.mode_chosen',
      entityType: 'client',
      entityId: id,
      clientId: id,
      metadata: { mode: 'A' },
    });
    return { ok: true, message: 'Saved.', next: stepHref('posting', id) };
  });
}

export async function reviewPostingAction(clientId: string, unmapped: number): Promise<WizardResult> {
  const id = z.uuid().parse(clientId);
  const ctx = await adminFor(id);
  if (unmapped > 0) return { ok: false, message: 'Map every code that needs a decision first.' };
  return withTenant(getDb(), scope(ctx), async (tx) => {
    const l = await lockOnboarding(tx, id);
    if (!l) return NOT_ONBOARDING;
    await saveState(tx, l, { postingReviewed: true }, after('posting'));
    return { ok: true, message: 'Saved.', next: stepHref('automation', id) };
  });
}

/* O-09 Automation -------------------------------------------------------------------------------- */

const AutomationInput = z.object({
  reviewEverything: z.boolean(),
  /** null follows the company default. */
  threshold: z.number().int().min(50).max(100).nullable(),
});

const addDays = (ymd: string, n: number) =>
  new Date(Date.parse(`${ymd}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export async function setAutomationAction(
  clientId: string,
  input: z.input<typeof AutomationInput>,
): Promise<WizardResult> {
  const id = z.uuid().parse(clientId);
  const ctx = await adminFor(id);
  const parsed = AutomationInput.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'Use a threshold from 50 to 100.' };
  const v = parsed.data;
  return withTenant(getDb(), scope(ctx), async (tx) => {
    const l = await lockOnboarding(tx, id);
    if (!l) return NOT_ONBOARDING;
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: l.c.timezone }).format(clockNow());
    const reviewUntil = v.reviewEverything ? addDays(today, REVIEW_EVERYTHING_DAYS) : null;
    await tx
      .update(clients)
      .set({ autoReleaseThreshold: v.threshold, reviewUntil, updatedAt: clockNow() })
      .where(eq(clients.id, id));
    await saveState(tx, l, { automationSet: true }, after('automation'));
    await recordAudit(tx, {
      actor: actorOf(ctx),
      action: 'client.automation_set',
      entityType: 'client',
      entityId: id,
      clientId: id,
      metadata: { reviewUntil: reviewUntil ?? 'none', threshold: v.threshold ?? 'company default' },
    });
    return { ok: true, message: 'Saved.', next: stepHref('go-live', id) };
  });
}

/* O-10 Go live ----------------------------------------------------------------------------------- */

export async function setBillersAction(
  clientId: string,
  primaryId: string | null,
  backupId: string | null,
): Promise<WizardResult> {
  const id = z.uuid().parse(clientId);
  const ctx = await adminFor(id);
  const primary = primaryId ? z.uuid().parse(primaryId) : null;
  const backup = backupId ? z.uuid().parse(backupId) : null;
  if (primary && primary === backup) return { ok: false, message: 'Choose a different person as backup.' };
  return withTenant(getDb(), scope(ctx), async (tx) => {
    const l = await lockOnboarding(tx, id);
    if (!l) return NOT_ONBOARDING;
    for (const who of [primary, backup].filter((x): x is string => Boolean(x))) {
      const [m] = await tx
        .select({ role: memberships.role, scope: memberships.clientScope, ids: memberships.clientIds })
        .from(memberships)
        .where(and(eq(memberships.userId, who), eq(memberships.status, 'active')));
      if (!m || m.role === 'viewer' || (m.role === 'biller' && m.scope !== 'all' && !m.ids.includes(id)))
        return { ok: false, message: 'The primary and backup biller must be able to work this client.' };
    }
    await tx
      .update(clients)
      .set({ primaryBillerId: primary, backupBillerId: backup, updatedAt: clockNow() })
      .where(eq(clients.id, id));
    await recordAudit(tx, {
      actor: actorOf(ctx),
      action: 'client.settings_changed',
      entityType: 'client',
      entityId: id,
      clientId: id,
      metadata: {
        primaryBillerId: { from: l.c.primaryBillerId ?? 'none', to: primary ?? 'none' },
        backupBillerId: { from: l.c.backupBillerId ?? 'none', to: backup ?? 'none' },
      },
    });
    return { ok: true, message: 'Billers saved.' };
  });
}

export async function practiceInformedAction(clientId: string, informed: boolean): Promise<WizardResult> {
  const id = z.uuid().parse(clientId);
  const ctx = await adminFor(id);
  return withTenant(getDb(), scope(ctx), async (tx) => {
    const l = await lockOnboarding(tx, id);
    if (!l) return NOT_ONBOARDING;
    await saveState(tx, l, { practiceInformed: informed });
    return { ok: true, message: informed ? 'Marked as told.' : 'Marked as not told yet.' };
  });
}

/**
 * Go live: every checklist item again, then the client state machine, the connection onto the sync
 * schedule, the first sync now, and E-06 to the company's admins and the client's billers.
 */
export async function goLiveAction(clientId: string): Promise<WizardResult> {
  const id = z.uuid().parse(clientId);
  const ctx = await adminFor(id);
  const c = await onboardingClient(ctx, id);
  if (!c || c.status !== 'onboarding') return NOT_ONBOARDING;
  const open = checklistFor(c).filter((i) => !i.ok);
  if (open.length)
    return {
      ok: false,
      message: `${open.length === 1 ? 'One item is' : `${open.length} items are`} still open: ${open
        .map((i) => i.label.toLowerCase())
        .join('; ')}.`,
    };
  const now = clockNow();
  const res = await goLive(getDb(), scope(ctx), id, now);
  if (!res.ok) return NOT_ONBOARDING;
  if (res.connectionId && c.connection?.adapterKey !== 'manual')
    await sendSyncPull(await getBoss(), {
      tenantId: ctx.tenantId,
      connectionId: res.connectionId,
      trigger: 'manual',
      userId: ctx.user.id,
    });
  await sendClientLiveEmails(ctx, c, now);
  log.info({ clientId: id }, 'client went live');
  return { ok: true, message: `${c.name} is live.`, next: `/clients/${id}/live` };
}

async function sendClientLiveEmails(
  ctx: ActiveContext,
  c: NonNullable<Awaited<ReturnType<typeof onboardingClient>>>,
  goLiveAt: Date,
) {
  const people = await withTenant(getDb(), scope(ctx), async (tx) => {
    const [t] = await tx
      .select({ timeZone: tenants.timezone })
      .from(tenants)
      .where(eq(tenants.id, ctx.tenantId));
    const rows = await tx
      .select({ id: users.id, name: users.name, email: users.email, role: memberships.role })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.status, 'active'));
    return { timeZone: t?.timeZone ?? c.timezone, rows };
  });
  const nameOf = (uid: string | null) => people.rows.find((r) => r.id === uid)?.name ?? null;
  const to = people.rows.filter(
    (r) => r.role === 'admin' || r.id === c.primaryBillerId || r.id === c.backupBillerId,
  );
  const { APP_URL } = parseEnv(authEnvSchema.pick({ APP_URL: true }));
  const content = clientLiveEmail({
    clientName: c.name,
    pmName: c.connection?.pmName ?? c.state.pm?.pmName ?? 'the PM',
    mode: c.mode as 'A' | 'B' | 'C',
    goLiveAt,
    reviewUntil: c.reviewUntil,
    threshold: c.threshold,
    primaryBiller: nameOf(c.primaryBillerId),
    backupBiller: nameOf(c.backupBillerId),
    url: `${new URL(APP_URL).origin}/clients/${c.id}`,
    timeZone: people.timeZone,
  });
  let failed = 0;
  for (const r of to) {
    try {
      await getMailer().send(r.email, 'E-06', content);
    } catch (err) {
      failed++;
      log.warn(
        { template: 'E-06', code: (err as { code?: string }).code ?? 'unknown' },
        'client live email failed',
      );
    }
  }
  log.info({ template: 'E-06', sent: to.length - failed, failed }, 'client live emails');
}
