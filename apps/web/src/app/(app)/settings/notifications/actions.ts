'use server';
/**
 * S-09 Notifications: per event, the channels (in app, email right away, daily digest) and the
 * amount it must reach; the company's digest time and quiet hours. Admins only; audited with what
 * changed. Admins' connection and timely-filing emails cannot be turned off (S-09 rules).
 */
import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { notificationRules, recordAudit, tenants, withTenant } from '@cleanpost/db';
import { notify, policy } from '@cleanpost/domain';
import { getDb } from '@/lib/server';
import { requireActiveContext } from '@/lib/session';

export interface NotifySettingsResult {
  ok: boolean;
  message: string;
}

export async function saveNotificationSettings(input: notify.SettingsInput): Promise<NotifySettingsResult> {
  const ctx = await requireActiveContext();
  policy.assertAllowed(ctx.actor, 'users.manage');
  const parsed = notify.settingsInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'Check the amounts and times, then save again.' };
  const v = parsed.data;
  if (v.quietHours && v.quietHours.start === v.quietHours.end)
    return { ok: false, message: 'Quiet hours need different start and end times.' };
  return withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const [t] = await tx
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, ctx.tenantId))
      .for('update');
    const rules = await tx.select().from(notificationRules);
    const before = notify.companySettings(rules, t?.settings);
    const changed: Record<string, { from: unknown; to: unknown }> = {};

    for (const e of v.events) {
      const def = notify.EVENT_DEFS[e.event];
      const was = before.events[e.event];
      const channels = (['in_app', 'email', 'digest'] as const).filter((c) => e[c]);
      const threshold = def.thresholdCents === undefined ? null : (e.thresholdCents ?? def.thresholdCents);
      const same =
        channels.join() === (['in_app', 'email', 'digest'] as const).filter((c) => was.channels[c]).join() &&
        threshold === was.thresholdCents;
      if (same) continue;
      changed[e.event] = {
        // Channel names as a list: the audit log refuses metadata keys that name contact fields.
        from: {
          channels: (['in_app', 'email', 'digest'] as const).filter((c) => was.channels[c]),
          thresholdCents: was.thresholdCents,
        },
        to: { channels, thresholdCents: threshold },
      };
      await tx
        .insert(notificationRules)
        .values({
          tenantId: ctx.tenantId,
          eventType: e.event,
          channels,
          thresholdCents: threshold,
          enabled: true,
        })
        .onConflictDoUpdate({
          target: [notificationRules.tenantId, notificationRules.eventType],
          set: { channels, thresholdCents: threshold, enabled: true, updatedAt: new Date() },
        });
    }
    if (v.digestTime !== before.digestTime)
      changed.digestTime = { from: before.digestTime, to: v.digestTime };
    if (JSON.stringify(v.quietHours) !== JSON.stringify(before.quietHours))
      changed.quietHours = { from: before.quietHours ?? 'none', to: v.quietHours ?? 'none' };
    if (!Object.keys(changed).length) return { ok: true, message: 'Nothing to save.' };
    if (changed.digestTime || changed.quietHours) {
      const settings = (t?.settings ?? {}) as Record<string, unknown>;
      await tx
        .update(tenants)
        .set({
          settings: {
            ...settings,
            notifications: { digestTime: v.digestTime, quietHours: v.quietHours },
          },
        })
        .where(eq(tenants.id, ctx.tenantId));
    }
    await recordAudit(tx, {
      actor: `user:${ctx.user.id}`,
      action: 'notifications.settings_changed',
      entityType: 'tenant',
      entityId: ctx.tenantId,
      metadata: changed,
    });
    revalidatePath('/settings/notifications');
    const n = Object.keys(changed).length;
    return { ok: true, message: `Saved ${n === 1 ? 'one change' : `${n} changes`}.` };
  });
}
