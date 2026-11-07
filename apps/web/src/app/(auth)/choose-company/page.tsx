import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { inArray } from 'drizzle-orm';
import { ChevronRight } from 'lucide-react';
import { clientIp, listCompanies } from '@cleanpost/auth';
import { tenants, withUser } from '@cleanpost/db';
import { AuthCard } from '@/components/auth-card';
import { getDb } from '@/lib/server';
import { getContext } from '@/lib/session';
import { chooseCompanyAction } from './actions';
import { BlockedNotice, type BlockedReason } from './blocked-notice';

const REASONS = new Set<BlockedReason>(['passkeys_not_allowed', 'trusted_devices_not_allowed', 'network']);

export const metadata: Metadata = { title: 'Choose company' };

const ROLE = { admin: 'Admin', biller: 'Biller', viewer: 'Viewer' } as Record<string, string>;

/**
 * A-07 Choose company. Single-membership users go straight in, unless that company turned this
 * sign-in away (S-12): then it says why and how to get in (DEC-34).
 */
export default async function ChooseCompanyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await getContext();
  if (ctx.status === 'signed_out') redirect('/sign-in');
  if (ctx.status === 'mfa_setup_required') redirect('/setup/two-factor');
  if (ctx.status === 'second_factor_required') redirect('/sign-in/passkey');
  const params = await searchParams;
  const reason = REASONS.has(params.blocked as BlockedReason) ? (params.blocked as BlockedReason) : null;
  const blockedId =
    ctx.status === 'company_blocked'
      ? ctx.tenantId
      : typeof params.company === 'string'
        ? params.company
        : null;
  const blocked = ctx.status === 'company_blocked' ? ctx.reason : reason;

  const db = getDb();
  const memberships = await listCompanies(db, ctx.user.id);
  const names = memberships.length
    ? await withUser(db, ctx.user.id, (tx) =>
        tx
          .select({ id: tenants.id, name: tenants.name, status: tenants.status })
          .from(tenants)
          .where(
            inArray(
              tenants.id,
              memberships.map((m) => m.tenantId),
            ),
          ),
      )
    : [];

  if (memberships.length === 0) {
    return (
      <AuthCard title="No company yet">
        <p className="muted">
          Your account isn&apos;t part of a billing company yet. Ask your admin to invite you, then sign in
          again.
        </p>
      </AuthCard>
    );
  }

  const companies = memberships
    .map((m) => ({ ...m, ...names.find((n) => n.id === m.tenantId) }))
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  const active = companies.filter((c) => c.status === 'active');
  const blockedName = blocked
    ? (companies.find((c) => c.tenantId === blockedId)?.name ?? 'This company')
    : null;
  if (active.length === 1 && ctx.status === 'choose_company' && !blocked) {
    const form = new FormData();
    form.set('tenantId', active[0]!.tenantId);
    await chooseCompanyAction(form);
  }

  return (
    <AuthCard title="Choose a company">
      {blocked && blockedName && (
        <BlockedNotice reason={blocked} company={blockedName} address={clientIp(await headers())} />
      )}
      <ul className="stack-sm" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {companies.map((c) => (
          <li key={c.tenantId}>
            <form action={chooseCompanyAction}>
              <input type="hidden" name="tenantId" value={c.tenantId} />
              <button
                type="submit"
                className="option-card"
                style={{ width: '100%', flexDirection: 'row', alignItems: 'center' }}
                disabled={c.status !== 'active'}
              >
                <span className="stack-sm" style={{ gap: 0, flex: 1 }}>
                  <b>{c.name}</b>
                  <span className="dense muted">
                    {c.status === 'active' ? ROLE[c.role] : 'Suspended: contact Cleanpost support'}
                  </span>
                </span>
                <ChevronRight aria-hidden />
              </button>
            </form>
          </li>
        ))}
      </ul>
    </AuthCard>
  );
}
