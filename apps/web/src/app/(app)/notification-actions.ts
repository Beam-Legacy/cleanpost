'use server';
/**
 * G-04 Notifications for the signed-in person: their in-app list, unread count, mark read. Rows
 * carry no PHI (client, payer, amounts) and a link into the app by record ID.
 */
import { and, count, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { clients, notifications, withTenant } from '@cleanpost/db';
import { notify } from '@cleanpost/domain';
import { getDb } from '@/lib/server';
import { requireActiveContext } from '@/lib/session';

export interface NotificationView {
  id: string;
  type: string;
  summary: string;
  detail: string | null;
  clientName: string | null;
  link: string | null;
  urgent: boolean;
  read: boolean;
  createdAt: string;
}

/** Rows made before alerts carried links (assignments, write-off decisions) open their record. */
function linkOf(r: { link: string | null; entityType: string | null; entityId: string | null }) {
  if (r.link) return r.link;
  if (r.entityType === 'work_item' && r.entityId) return `/work?item=${r.entityId}`;
  if (r.entityType === 'claim' && r.entityId) return `/claims/${r.entityId}`;
  return null;
}

const URGENT_TYPES = new Set<string>(notify.NOTIFY_EVENTS.filter((e) => notify.EVENT_DEFS[e].urgent));

export async function unreadNotificationCount(): Promise<number> {
  const ctx = await requireActiveContext();
  const [r] = await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, (tx) =>
    tx
      .select({ n: count() })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, ctx.user.id),
          eq(notifications.inApp, true),
          isNull(notifications.readAt),
        ),
      ),
  );
  return r?.n ?? 0;
}

/** The latest 60 in-app notifications, newest first. */
export async function listNotifications(): Promise<NotificationView[]> {
  const ctx = await requireActiveContext();
  const rows = await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, (tx) =>
    tx
      .select({
        id: notifications.id,
        type: notifications.type,
        summary: notifications.summary,
        detail: notifications.detail,
        link: notifications.link,
        entityType: notifications.entityType,
        entityId: notifications.entityId,
        urgent: notifications.urgent,
        readAt: notifications.readAt,
        createdAt: notifications.createdAt,
        clientName: clients.name,
      })
      .from(notifications)
      .leftJoin(clients, eq(clients.id, notifications.clientId))
      .where(and(eq(notifications.userId, ctx.user.id), eq(notifications.inApp, true)))
      .orderBy(desc(notifications.createdAt))
      .limit(60),
  );
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    summary: r.summary,
    detail: r.detail,
    clientName: r.clientName,
    link: linkOf(r),
    urgent: r.urgent || URGENT_TYPES.has(r.type),
    read: r.readAt !== null,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function markNotificationRead(id: string): Promise<void> {
  const ctx = await requireActiveContext();
  const nid = z.uuid().parse(id);
  await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, (tx) =>
    tx
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(eq(notifications.id, nid), eq(notifications.userId, ctx.user.id), isNull(notifications.readAt)),
      ),
  );
}

export async function markAllNotificationsRead(): Promise<void> {
  const ctx = await requireActiveContext();
  await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, (tx) =>
    tx
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.userId, ctx.user.id), isNull(notifications.readAt))),
  );
}
