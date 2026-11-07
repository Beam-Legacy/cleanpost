import 'server-only';
/**
 * The company's own settings pages (DEC-34): S-14 company profile with its agreements, S-12
 * security, S-10 branding. Contacts are workforce details, not patient data.
 */
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import {
  claims,
  clients,
  memberships,
  passkeys,
  tenantAgreements,
  tenants,
  users,
  withTenant,
} from '@cleanpost/db';
import { company } from '@cleanpost/domain';
import { getDb } from '@/lib/server';
import type { ActiveContext } from '@/lib/session';

export interface AgreementRow {
  id: string;
  type: 'baa' | 'customer_agreement';
  version: string;
  signedAt: Date | null;
  signedBy: string | null;
  downloadable: boolean;
}

/** S-14: the profile as the form edits it, and the latest agreement of each kind. */
export async function companyProfile(ctx: ActiveContext) {
  return withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const [t] = await tx.select().from(tenants).where(eq(tenants.id, ctx.tenantId));
    const rows = await tx
      .select()
      .from(tenantAgreements)
      .orderBy(desc(tenantAgreements.signedAt), desc(tenantAgreements.createdAt));
    const latest = (type: AgreementRow['type']) => {
      const a = rows.find((r) => r.type === type);
      return a
        ? {
            id: a.id,
            type,
            version: a.version,
            signedAt: a.signedAt,
            signedBy: a.signedBy,
            downloadable: Boolean(a.storageKey),
          }
        : null;
    };
    const tz = company.US_TIME_ZONES.some((z) => z.id === t?.timezone)
      ? (t!.timezone as company.TimeZoneId)
      : 'America/Los_Angeles';
    return {
      profile: {
        legalName: t?.legalName ?? '',
        name: t?.name ?? '',
        address: company.readAddress(t?.address),
        phone: t?.phone ?? '',
        timezone: tz,
        securityContact: company.readContact(t?.securityContact),
        billingContact: company.readContact(t?.billingContact),
      },
      baa: latest('baa'),
      customerAgreement: latest('customer_agreement'),
    };
  });
}

/** S-12: the settings, and how many people sign in with a passkey only (turning passkeys off locks them to an app). */
export async function securityPage(ctx: ActiveContext) {
  return withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const [t] = await tx
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, ctx.tenantId));
    const people = await tx
      .select({ id: users.id, totp: users.twoFactorEnabled })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(ne(memberships.status, 'deactivated'));
    const noApp = people.filter((p) => !p.totp).map((p) => p.id);
    const withKey = noApp.length
      ? await tx
          .selectDistinct({ userId: passkeys.userId })
          .from(passkeys)
          .where(inArray(passkeys.userId, noApp))
      : [];
    const [me] = await tx
      .select({ totp: users.twoFactorEnabled })
      .from(users)
      .where(eq(users.id, ctx.user.id));
    return {
      settings: company.securitySettings(t?.settings),
      passkeyOnly: withKey.length,
      /** How this admin confirms a change (step-up): their authenticator, else their passkey. */
      stepUpWith: me?.totp ? ('code' as const) : ('passkey' as const),
    };
  });
}

/** S-10: the branding, the company name, and a client with last month's claims for the preview. */
export async function brandingPage(ctx: ActiveContext) {
  return withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const [t] = await tx
      .select({ name: tenants.name, settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, ctx.tenantId));
    const [sample] = await tx
      .select({ id: clients.id, name: clients.name })
      .from(clients)
      .where(
        and(
          ne(clients.status, 'offboarded'),
          sql`exists (select 1 from ${claims} where ${claims.clientId} = ${clients.id})`,
        ),
      )
      .orderBy(asc(clients.name))
      .limit(1);
    return {
      companyName: t?.name ?? '',
      branding: company.branding(t?.settings),
      sampleClient: sample ?? null,
    };
  });
}

/** F-01 and the logo route: the company's branding and display name. */
export async function companyBranding(ctx: ActiveContext) {
  return withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const [t] = await tx
      .select({ name: tenants.name, settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, ctx.tenantId));
    return { companyName: t?.name ?? '', branding: company.branding(t?.settings) };
  });
}
