'use client';
/**
 * G-04 Notifications: the bell in the top bar with the unread count, and the drawer listing alerts
 * (All / Unread / Urgent), grouped Today / Earlier this week / Older. Opening one marks it read and
 * goes to the record. The count refreshes every minute.
 */
import { useCallback, useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import {
  Bell,
  CircleCheck,
  CircleX,
  Clock,
  PlugZap,
  Receipt,
  Scale,
  Sparkles,
  UserPlus,
  type LucideIcon,
} from 'lucide-react';
import { Button, Drawer, IconButton } from '@cleanpost/ui';
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  unreadNotificationCount,
  type NotificationView,
} from '@/app/(app)/notification-actions';

const ICON: Record<string, LucideIcon> = {
  connection_failed: PlugZap,
  out_of_balance: Scale,
  timely_filing: Clock,
  sla_breach: Clock,
  large_denial: CircleX,
  rule_proposed: Sparkles,
  client_live: CircleCheck,
  'work_item.assigned': UserPlus,
  write_off_approved: Receipt,
  write_off_declined: Receipt,
};

type Filter = 'all' | 'unread' | 'urgent';

const dayKey = (d: Date) => d.toLocaleDateString('en-CA');

function groupOf(d: Date, now: Date): 'Today' | 'Earlier this week' | 'Older' {
  if (dayKey(d) === dayKey(now)) return 'Today';
  return now.getTime() - d.getTime() < 6 * 86_400_000 ? 'Earlier this week' : 'Older';
}

function when(d: Date, now: Date): string {
  const g = groupOf(d, now);
  if (g === 'Today')
    return d
      .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
      .replace(/ ([AP])M$/, (_, x: string) => ` ${x.toLowerCase()}m`);
  if (g === 'Earlier this week') return d.toLocaleDateString('en-US', { weekday: 'short' });
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function NotificationBell({
  initialUnread,
  settingsHref,
}: {
  initialUnread: number;
  /** S-09 for admins; the person's own email switches (A-09) for everyone else. */
  settingsHref: string;
}) {
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(initialUnread);
  const [items, setItems] = useState<NotificationView[] | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [pending, start] = useTransition();

  const refreshCount = useCallback(() => {
    unreadNotificationCount()
      .then(setUnread)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const t = setInterval(refreshCount, 60_000);
    return () => clearInterval(t);
  }, [refreshCount]);

  useEffect(() => {
    if (!open) return;
    listNotifications()
      .then((rows) => {
        setItems(rows);
        setUnread(rows.filter((r) => !r.read).length);
      })
      .catch(() => setItems([]));
  }, [open]);

  const now = new Date();
  const shown = (items ?? []).filter((n) =>
    filter === 'unread' ? !n.read : filter === 'urgent' ? n.urgent : true,
  );
  const unreadCount = (items ?? []).filter((n) => !n.read).length;
  const urgentCount = (items ?? []).filter((n) => n.urgent && !n.read).length;
  const groups = (['Today', 'Earlier this week', 'Older'] as const)
    .map((g) => ({ g, rows: shown.filter((n) => groupOf(new Date(n.createdAt), now) === g) }))
    .filter((x) => x.rows.length);

  /** Opening one marks it read; its link (a real link, so it also opens in a new tab) does the rest. */
  const openOne = (n: NotificationView) => {
    if (!n.read) {
      setItems((xs) => xs?.map((x) => (x.id === n.id ? { ...x, read: true } : x)) ?? null);
      setUnread((u) => Math.max(0, u - 1));
      markNotificationRead(n.id).catch(() => undefined);
    }
    if (n.link) setOpen(false);
  };

  return (
    <>
      <span style={{ position: 'relative', display: 'inline-flex' }}>
        <IconButton
          label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
          ghost
          icon={<Bell aria-hidden />}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        />
        {unread > 0 && (
          <span
            className="count-badge strong"
            aria-hidden
            style={{ position: 'absolute', top: -2, right: -4, pointerEvents: 'none' }}
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </span>
      <Drawer
        open={open}
        onOpenChange={setOpen}
        title="Notifications"
        footer={
          <Link href={settingsHref} className="dense" onClick={() => setOpen(false)}>
            Notification settings
          </Link>
        }
      >
        <div className="row" style={{ gap: 8 }}>
          <div className="segmented" role="group" aria-label="Show">
            {(
              [
                ['all', 'All'],
                ['unread', `Unread${unreadCount ? ` ${unreadCount}` : ''}`],
                ['urgent', `Urgent${urgentCount ? ` ${urgentCount}` : ''}`],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={filter === key ? 'active' : undefined}
                aria-pressed={filter === key}
                onClick={() => setFilter(key)}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="spacer" />
          <Button
            size="sm"
            variant="ghost"
            disabled={!unreadCount || pending}
            onClick={() =>
              start(async () => {
                await markAllNotificationsRead();
                setItems((xs) => xs?.map((x) => ({ ...x, read: true })) ?? null);
                setUnread(0);
              })
            }
          >
            Mark all read
          </Button>
        </div>
        {items === null ? (
          <p className="muted dense">Loading…</p>
        ) : !groups.length ? (
          <div className="empty" style={{ padding: '32px 0' }}>
            <div className="glyph good" aria-hidden>
              <CircleCheck />
            </div>
            <h2>You&apos;re all caught up.</h2>
          </div>
        ) : (
          groups.map(({ g, rows }) => (
            <section key={g} className="stack-sm" style={{ gap: 4 }} aria-label={g}>
              <span className="overline">{g}</span>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} className="stack-sm">
                {rows.map((n) => {
                  const Icon = ICON[n.type] ?? Bell;
                  const meta = [
                    n.clientName && !n.summary.startsWith(n.clientName) ? n.clientName : null,
                    n.detail,
                    when(new Date(n.createdAt), now),
                  ]
                    .filter(Boolean)
                    .join(' · ');
                  return (
                    <li key={n.id}>
                      {(() => {
                        const body = (
                          <>
                            <Icon
                              aria-hidden
                              style={{
                                color: n.urgent && !n.read ? 'var(--danger)' : undefined,
                                flex: 'none',
                              }}
                            />
                            <span>
                              <b>{n.summary}</b>
                              {!n.read && <span className="sr-only"> (unread)</span>}
                              <span className="muted dense" style={{ display: 'block' }}>
                                {meta}
                              </span>
                            </span>
                          </>
                        );
                        const style = {
                          width: '100%',
                          textAlign: 'left' as const,
                          alignItems: 'flex-start',
                          color: 'inherit',
                          textDecoration: 'none',
                          background: n.read ? undefined : 'var(--cobalt-tint)',
                        };
                        return n.link ? (
                          <Link href={n.link} className="menu-item" style={style} onClick={() => openOne(n)}>
                            {body}
                          </Link>
                        ) : (
                          <button
                            type="button"
                            className="menu-item"
                            style={style}
                            onClick={() => openOne(n)}
                          >
                            {body}
                          </button>
                        );
                      })()}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </Drawer>
    </>
  );
}
