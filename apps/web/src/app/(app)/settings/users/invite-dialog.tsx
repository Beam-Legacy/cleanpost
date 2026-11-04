'use client';
/**
 * S-02 Invite user: one or more work emails (comma separated), a role, and the clients a biller or
 * viewer will see. Each address gets an E-01 email; the invite shows on S-01 as pending.
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { UserPlus } from 'lucide-react';
import { Button, Modal, useToast } from '@cleanpost/ui';
import { inviteUsers, type UserActionResult } from './actions';
import { InviteLinks } from './invite-links';

type Role = 'admin' | 'biller' | 'viewer';

const ROLES: { value: Role; label: string; help: string }[] = [
  { value: 'admin', label: 'Admin', help: 'everything, including users and integrations' },
  { value: 'biller', label: 'Biller', help: 'works the queue for assigned clients' },
  { value: 'viewer', label: 'Viewer', help: 'reports and claims, read only' },
];

export function InviteDialog({ clients }: { clients: { id: string; name: string }[] }) {
  const [open, setOpen] = useState(false);
  const [emails, setEmails] = useState('');
  const [role, setRole] = useState<Role>('biller');
  const [picked, setPicked] = useState<string[]>([]);
  const [refused, setRefused] = useState<UserActionResult['refused']>([]);
  const [error, setError] = useState<string | null>(null);
  const [links, setLinks] = useState<UserActionResult['links']>();
  const [pending, start] = useTransition();
  const toast = useToast();
  const router = useRouter();

  const needsClients = role !== 'admin';
  const ready = emails.trim().length > 0 && (!needsClients || picked.length > 0);

  const reset = () => {
    setEmails('');
    setRole('biller');
    setPicked([]);
    setRefused([]);
    setError(null);
    setLinks(undefined);
  };

  const submit = () =>
    start(async () => {
      setError(null);
      const res = await inviteUsers({ emails, role, clientIds: needsClients ? picked : [] });
      setRefused(res.refused ?? []);
      if (res.ok) {
        toast({ message: res.message });
        router.refresh();
        if (res.links) setLinks(res.links);
        else if (!res.refused?.length) {
          setOpen(false);
          reset();
        } else {
          // Keep the dialog open on the addresses that were not invited.
          setEmails(res.refused.map((r) => r.email).join(', '));
        }
      } else setError(res.message);
    });

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
      trigger={
        <Button variant="primary" size="sm">
          <UserPlus aria-hidden />
          Invite user
        </Button>
      }
      title="Invite user"
      size="sm"
      footer={
        links ? (
          <Button variant="primary" onClick={() => setOpen(false)}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" disabled={pending || !ready} aria-busy={pending} onClick={submit}>
              {pending ? 'Sending…' : 'Send invite'}
            </Button>
          </>
        )
      }
    >
      {links ? (
        <div className="stack">
          <InviteLinks links={links} />
          {refused && refused.length > 0 && (
            <ul className="error" role="alert" style={{ margin: 0, paddingLeft: 18 }}>
              {refused.map((r) => (
                <li key={r.email}>
                  {r.email} {r.reason}.
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="stack">
          <div className="field">
            <label htmlFor="invite-emails">Work email</label>
            <input
              id="invite-emails"
              className="input"
              type="text"
              inputMode="email"
              autoComplete="off"
              value={emails}
              onChange={(e) => setEmails(e.target.value)}
              placeholder="name@yourcompany.com"
              aria-describedby="invite-emails-help"
              aria-invalid={refused?.length ? true : undefined}
            />
            <span className="help" id="invite-emails-help">
              Separate more than one address with commas.
            </span>
            {refused && refused.length > 0 && (
              <ul
                className="error"
                role="alert"
                style={{ flexDirection: 'column', alignItems: 'flex-start', margin: 0, paddingLeft: 18 }}
              >
                {refused.map((r) => (
                  <li key={r.email}>
                    {r.email} {r.reason}.
                  </li>
                ))}
              </ul>
            )}
          </div>
          <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="label" style={{ marginBottom: 6 }}>
              Role
            </legend>
            <div className="stack-sm">
              {ROLES.map((r) => (
                <label key={r.value} className="check">
                  <input
                    type="radio"
                    name="invite-role"
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
              aria-describedby="invite-clients-help"
            >
              <legend className="label" style={{ marginBottom: 6 }}>
                Clients
              </legend>
              <div className="stack-sm invite-clients">
                {clients.map((c) => (
                  <label key={c.id} className="check">
                    <input type="checkbox" checked={picked.includes(c.id)} onChange={() => toggle(c.id)} />
                    <span>{c.name}</span>
                  </label>
                ))}
              </div>
              <span className="help" id="invite-clients-help">
                {role === 'biller' ? 'Billers' : 'Viewers'} see only these clients.
              </span>
            </fieldset>
          )}
          <p className="muted dense" style={{ margin: 0 }}>
            They will set a password and two-factor sign-in when they accept. The invite expires in 7 days.
          </p>
          {error && (
            <span className="error" role="alert">
              {error}
            </span>
          )}
        </div>
      )}
    </Modal>
  );
}
