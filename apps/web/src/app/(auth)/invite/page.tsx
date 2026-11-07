import type { Metadata } from 'next';
import Link from 'next/link';
import { PASSWORD_MIN_LENGTH, invitationByToken, type InviteView } from '@cleanpost/auth';
import { now as clockNow } from '@cleanpost/clock';
import { AuthCard } from '@/components/auth-card';
import { formatDate } from '@/lib/format';
import { getDb } from '@/lib/server';
import { getContext } from '@/lib/session';
import { AcceptForm } from './accept-form';
import { joinAction } from './actions';

export const metadata: Metadata = { title: 'Accept invite' };

const ROLE = { admin: 'Admin', biller: 'Biller', viewer: 'Viewer' } as const;

function Summary({ invite }: { invite: InviteView }) {
  const access =
    invite.role === 'admin' || invite.clientCount === null
      ? 'with access to all clients'
      : `with access to ${invite.clientCount} ${invite.clientCount === 1 ? 'client' : 'clients'}`;
  return (
    <p className="muted" style={{ margin: 0 }}>
      {invite.inviterName} invited you as {invite.role === 'admin' ? 'an' : 'a'}{' '}
      <span className="chip">{ROLE[invite.role]}</span> {access}.
    </p>
  );
}

/**
 * A-06 Accept invite (/invite?token=, from the E-01 email). The token is the only key: the page shows
 * the company, inviter, role and client count, never more. Expired, withdrawn and used links say so.
 */
export default async function InvitePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = (await searchParams).token;
  const token = typeof raw === 'string' ? raw : '';
  const ctx = await getContext();
  const invite = token ? await invitationByToken(getDb(), token, clockNow()) : null;
  const self = `/invite?token=${encodeURIComponent(token)}`;

  if (!invite)
    return (
      <AuthCard title="This invite link doesn't work">
        <p className="muted">
          It may have been replaced by a newer invite, or copied only in part. Ask the person who invited you
          to send it again.
        </p>
        <Link className="btn btn-secondary btn-lg btn-block" href="/sign-in">
          Go to sign in
        </Link>
      </AuthCard>
    );
  if (invite.status === 'expired')
    return (
      <AuthCard title="This invite has expired">
        <p className="muted">
          Invites last 7 days; this one ended {formatDate(invite.expiresAt.toISOString().slice(0, 10))}. Ask{' '}
          {invite.inviterName} at {invite.tenantName} to send it again.
        </p>
      </AuthCard>
    );
  if (invite.status === 'revoked')
    return (
      <AuthCard title="This invite was withdrawn">
        <p className="muted">
          {invite.tenantName} withdrew it. If you still need access, ask {invite.inviterName}.
        </p>
      </AuthCard>
    );
  if (invite.status === 'accepted')
    return (
      <AuthCard title="Invite already accepted">
        <p className="muted">You have already joined {invite.tenantName}. Sign in to get started.</p>
        <Link className="btn btn-primary btn-lg btn-block" href="/sign-in">
          Sign in
        </Link>
      </AuthCard>
    );

  const signedIn =
    ctx.status === 'ok' || ctx.status === 'choose_company' || ctx.status === 'company_blocked'
      ? ctx.user
      : null;
  if (signedIn && signedIn.email.toLowerCase() !== invite.email)
    return (
      <AuthCard title={`Join ${invite.tenantName}`}>
        <Summary invite={invite} />
        <p className="muted">
          This invite is for <b>{invite.email}</b>, and you are signed in as <b>{signedIn.email}</b>. Sign
          out, then open the link from the email again.
        </p>
      </AuthCard>
    );
  if (signedIn)
    return (
      <AuthCard title={`Join ${invite.tenantName}`}>
        <Summary invite={invite} />
        <form action={joinAction}>
          <input type="hidden" name="token" value={token} />
          <button type="submit" className="btn btn-primary btn-lg btn-block">
            Join {invite.tenantName}
          </button>
        </form>
      </AuthCard>
    );
  if (ctx.status === 'mfa_setup_required')
    return (
      <AuthCard title={`Join ${invite.tenantName}`}>
        <Summary invite={invite} />
        <p className="muted">Set up two-factor sign-in first; then you come back here to join.</p>
        <Link
          className="btn btn-primary btn-lg btn-block"
          href={`/setup/two-factor?next=${encodeURIComponent(self)}`}
        >
          Set up two-factor sign-in
        </Link>
      </AuthCard>
    );
  if (invite.existingUser)
    return (
      <AuthCard title={`Join ${invite.tenantName}`}>
        <Summary invite={invite} />
        <p className="muted">
          <b>{invite.email}</b> already has a Cleanpost account. Sign in to add {invite.tenantName} to it.
        </p>
        <Link className="btn btn-primary btn-lg btn-block" href={`/sign-in?next=${encodeURIComponent(self)}`}>
          Sign in to accept
        </Link>
      </AuthCard>
    );
  return (
    <AuthCard title={`Join ${invite.tenantName}`}>
      <Summary invite={invite} />
      <AcceptForm token={token} email={invite.email} minLength={PASSWORD_MIN_LENGTH} />
      <p className="muted dense" style={{ margin: 0, textAlign: 'center' }}>
        Already have a Cleanpost account?{' '}
        <Link className="inline-link" href={`/sign-in?next=${encodeURIComponent(self)}`}>
          Sign in to accept
        </Link>
      </p>
    </AuthCard>
  );
}
