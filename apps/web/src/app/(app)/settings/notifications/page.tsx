import type { Metadata } from 'next';
import { eq } from 'drizzle-orm';
import { notificationRules, tenants, withTenant } from '@cleanpost/db';
import { notify } from '@cleanpost/domain';
import { getDb } from '@/lib/server';
import { requireActiveContext } from '@/lib/session';
import { NotificationForm } from './notification-form';

export const metadata: Metadata = { title: 'Notifications' };

const ZONE: Record<string, string> = {
  'America/New_York': 'Eastern',
  'America/Chicago': 'Central',
  'America/Denver': 'Mountain',
  'America/Phoenix': 'Arizona',
  'America/Los_Angeles': 'Pacific',
  'America/Anchorage': 'Alaska',
  'Pacific/Honolulu': 'Hawaii',
};

/**
 * S-09 Notifications: which events reach whom and through which channel (in app, email right away,
 * daily digest), the amounts that matter, the digest time and quiet hours (DEC-28).
 */
export default async function NotificationSettingsPage() {
  const ctx = await requireActiveContext();
  const { settings, timeZone } = await withTenant(
    getDb(),
    { tenantId: ctx.tenantId, userId: ctx.user.id },
    async (tx) => {
      const rules = await tx.select().from(notificationRules);
      const [t] = await tx
        .select({ settings: tenants.settings, timezone: tenants.timezone })
        .from(tenants)
        .where(eq(tenants.id, ctx.tenantId));
      return {
        settings: notify.companySettings(rules, t?.settings),
        timeZone: t?.timezone ?? 'America/Los_Angeles',
      };
    },
  );
  return (
    <>
      <div>
        <h2 className="title-m">Notifications</h2>
        <p className="muted dense" style={{ margin: 0 }}>
          Who hears about what, and how
        </p>
      </div>
      <NotificationForm settings={settings} timeZoneLabel={`${ZONE[timeZone] ?? timeZone} time`} />
    </>
  );
}
