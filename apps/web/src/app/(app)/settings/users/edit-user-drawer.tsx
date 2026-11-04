'use client';
/**
 * S-03 Edit user: role and clients (Save), then security: reset two-factor, sign out everywhere,
 * deactivate (G-11 confirm; their open items go back to the queue) or reactivate. Everything is
 * audited (packages/auth members). The owner's row and your own have no Edit (S-01).
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, ConfirmDialog, Drawer, useToast } from '@cleanpost/ui';
import {
  deactivateMember,
  reactivateMember,
  resetMemberTwoFactorAction,
  saveMemberAccess,
  signOutMember,
  type UserActionResult,
} from './actions';

type Role = 'admin' | 'biller' | 'viewer';

export interface EditableMember {
  membershipId: string;
  name: string;
  email: string;
  role: Role;
  /** 'all' or the client ids they see. */
  clientIds: 'all' | string[];
  status: 'active' | 'invited' | 'deactivated';
  twoFactor: 'passkey' | 'authenticator' | null;
  joined: string;
  sessions: number;
  openItems: number;
  elsewhere: boolean;
}

const ROLES: { value: Role; label: string; help: string }[] = [
  { value: 'admin', label: 'Admin', help: 'everything, including users and integrations' },
  { value: 'biller', label: 'Biller', help: 'works the queue for assigned clients' },
  { value: 'viewer', label: 'Viewer', help: 'reports and claims, read only' },
];

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function EditUserDrawer({
  member: m,
  clients,
  tenantName,
}: {
  member: EditableMember;
  clients: { id: string; name: string }[];
  tenantName: string;
}) {
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<Role>(m.role);
  const [picked, setPicked] = useState<string[]>(m.clientIds === 'all' ? [] : m.clientIds);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const toast = useToast();
  const router = useRouter();
  const active = m.status === 'active';
  const needsClients = role !== 'admin';
  const removed =
    needsClients && m.clientIds !== 'all'
      ? m.clientIds.filter((id) => !picked.includes(id)).length
      : needsClients && m.clientIds === 'all'
        ? clients.length - picked.length
        : 0;

  const run = (fn: () => Promise<UserActionResult>, close = false) =>
    start(async () => {
      setError(null);
      const res = await fn();
      if (res.ok) {
        toast({ message: res.message });
        if (close) setOpen(false);
        router.refresh();
      } else setError(res.message);
    });

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  return (
    <>
      <Drawer
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (o) {
            setRole(m.role);
            setPicked(m.clientIds === 'all' ? [] : m.clientIds);
            setError(null);
          }
        }}
        trigger={
          <Button size="sm" variant="ghost">
            Edit<span className="sr-only"> {m.name}</span>
          </Button>
        }
        title={m.name}
        description={`${m.email} · joined ${m.joined}`}
        footer={
          active ? (
            <>
              <Button onClick={() => setOpen(false)}>Cancel</Button>
              <Button
                variant="primary"
                disabled={pending || (needsClients && picked.length === 0)}
                onClick={() => run(() => saveMemberAccess(m.membershipId, { role, clientIds: picked }), true)}
              >
                Save
              </Button>
            </>
          ) : undefined
        }
      >
        <div className="stack">
          {!active && (
            <p className="muted" style={{ margin: 0 }}>
              Deactivated: they cannot open {tenantName}. Reactivate to give their access back as it was.
            </p>
          )}
          {active && (
            <>
              <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className="label" style={{ marginBottom: 6 }}>
                  Role
                </legend>
                <div className="stack-sm">
                  {ROLES.map((r) => (
                    <label key={r.value} className="check">
                      <input
                        type="radio"
                        name={`role-${m.membershipId}`}
                        value={r.value}
                        checked={role === r.value}
                        onChange={() => setRole(r.value)}
                      />
                      <span>
                        <b>{r.label}</b> <span className="muted">· {r.help}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              {needsClients && (
                <fieldset
                  className="field"
                  style={{ border: 0, padding: 0, margin: 0 }}
                  aria-describedby={`clients-help-${m.membershipId}`}
                >
                  <legend className="label" style={{ marginBottom: 6 }}>
                    Clients
                  </legend>
                  <div className="stack-sm invite-clients">
                    {clients.map((c) => (
                      <label key={c.id} className="check">
                        <input
                          type="checkbox"
                          checked={picked.includes(c.id)}
                          onChange={() => toggle(c.id)}
                        />
                        <span>{c.name}</span>
                      </label>
                    ))}
                  </div>
                  <span className="help" id={`clients-help-${m.membershipId}`}>
                    {removed > 0 && m.openItems > 0
                      ? `Their open items for ${plural(removed, 'removed client')} go back to the queue when you save.`
                      : `${role === 'biller' ? 'Billers' : 'Viewers'} see only these clients.`}
                  </span>
                </fieldset>
              )}
            </>
          )}

          <div className="stack-sm">
            <h3 className="title-s" style={{ margin: 0 }}>
              Security
            </h3>
            <dl className="kv dense">
              <dt>Two-factor</dt>
              <dd>
                {m.twoFactor === 'passkey'
                  ? 'Passkey'
                  : m.twoFactor === 'authenticator'
                    ? 'Authenticator app'
                    : 'Not set up yet'}
              </dd>
              <dt>Signed in here</dt>
              <dd>{m.sessions ? plural(m.sessions, 'session') : 'No sessions'}</dd>
              <dt>Open work items</dt>
              <dd>{m.openItems}</dd>
            </dl>
            {active && (
              <div className="row dense" style={{ gap: 8 }}>
                <Button
                  size="sm"
                  disabled={pending || !m.twoFactor || m.elsewhere}
                  onClick={() => run(() => resetMemberTwoFactorAction(m.membershipId))}
                >
                  Reset two-factor
                </Button>
                <Button
                  size="sm"
                  disabled={pending || m.sessions === 0}
                  onClick={() => run(() => signOutMember(m.membershipId))}
                >
                  Sign out everywhere
                </Button>
              </div>
            )}
            {active && m.elsewhere && m.twoFactor && (
              <p className="help muted dense" style={{ margin: 0 }}>
                They also work in another company, so two-factor is theirs to manage (a recovery code, or
                Cleanpost support).
              </p>
            )}
          </div>

          <div className="stack-sm">
            <h3 className="title-s" style={{ margin: 0 }}>
              Access
            </h3>
            {active ? (
              <>
                <p className="muted dense" style={{ margin: 0 }}>
                  Deactivating ends their access to {tenantName} now. Their history stays.
                </p>
                <div>
                  <Button size="sm" variant="danger" disabled={pending} onClick={() => setConfirm(true)}>
                    Deactivate
                  </Button>
                </div>
              </>
            ) : (
              <div>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={pending}
                  onClick={() => run(() => reactivateMember(m.membershipId), true)}
                >
                  Reactivate
                </Button>
              </div>
            )}
          </div>
          {error && (
            <span className="error" role="alert">
              {error}
            </span>
          )}
        </div>
      </Drawer>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Deactivate ${m.name}?`}
        description={
          <p style={{ margin: 0 }}>
            They lose access to {tenantName} now and are signed out here.
            {m.openItems > 0 &&
              ` Their ${plural(m.openItems, 'open item')} go back to the queue unassigned.`}{' '}
            You can reactivate them later.
          </p>
        }
        confirmLabel={`Deactivate ${m.name}`}
        danger
        onConfirm={() => {
          setConfirm(false);
          run(() => deactivateMember(m.membershipId), true);
        }}
      />
    </>
  );
}
