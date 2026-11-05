import type { Metadata } from 'next';
import { and, eq } from 'drizzle-orm';
import { tenants, userPreferences, withTenant } from '@cleanpost/db';
import { notify } from '@cleanpost/domain';
import { Card, CardBody, CardHead, KeyValue, StatusChip } from '@cleanpost/ui';
import { PageHead } from '@/components/page';
import { getDb } from '@/lib/server';
import { requireActiveContext } from '@/lib/session';
import { EmailPreferences } from './email-preferences';
import { SignOutOthers } from './sign-out-others';

const timeLabel = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
};

export const metadata: Metadata = { title: 'Profile and security' };

/** A-09 Profile and security: identity, second factor, sessions, and the person's own emails. */
export default async function AccountPage() {
  const ctx = await requireActiveContext();
  const { prefs, digestTime } = await withTenant(
    getDb(),
    { tenantId: ctx.tenantId, userId: ctx.user.id },
    async (tx) => {
      const [p] = await tx
        .select({
          digestEmail: userPreferences.digestEmail,
          alertEmail: userPreferences.alertEmail,
          digestTime: userPreferences.digestTime,
        })
        .from(userPreferences)
        .where(and(eq(userPreferences.tenantId, ctx.tenantId), eq(userPreferences.userId, ctx.user.id)));
      const [t] = await tx
        .select({ settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, ctx.tenantId));
      return {
        prefs: p,
        digestTime: p?.digestTime?.slice(0, 5) ?? notify.companySettings([], t?.settings).digestTime,
      };
    },
  );
  return (
    <>
      <PageHead title="Profile and security" />
      <div className="grid-2">
        <Card>
          <CardHead title="Profile" />
          <CardBody>
            <KeyValue
              items={[
                ['Name', ctx.user.name],
                ['Email', ctx.user.email],
              ]}
            />
          </CardBody>
        </Card>
        <Card>
          <CardHead title="Sign-in security" />
          <CardBody className="stack">
            <KeyValue items={[['Two-factor sign-in', <StatusChip key="s" status="Healthy" />]]} />
            <SignOutOthers />
          </CardBody>
        </Card>
        <section id="email" className="card" aria-labelledby="email-h">
          <div className="card-head">
            <h2 id="email-h">Email</h2>
          </div>
          <div className="card-body">
            <EmailPreferences
              digestEmail={prefs?.digestEmail ?? true}
              alertEmail={prefs?.alertEmail ?? true}
              isAdmin={ctx.actor.role === 'admin'}
              digestTime={timeLabel(digestTime)}
            />
          </div>
        </section>
      </div>
    </>
  );
}
