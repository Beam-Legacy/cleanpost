import 'server-only';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { getSessionContext, type SessionContext } from '@cleanpost/auth';
import { getAuth, getDb, syncClock } from './server';

export type ActiveContext = Extract<SessionContext, { status: 'ok' }>;

/** The caller's session context, resolved once per request. */
export const getContext = cache(async (): Promise<SessionContext> => {
  await syncClock();
  return getSessionContext(getAuth(), getDb(), await headers());
});

/** For app pages: sends the user to whatever step they still owe (sign-in, MFA setup, company). */
export async function requireActiveContext(): Promise<ActiveContext> {
  const ctx = await getContext();
  if (ctx.status === 'ok') return ctx;
  if (ctx.status === 'signed_out')
    redirect(ctx.reason === 'expired' ? '/signed-out?reason=expired' : '/sign-in');
  if (ctx.status === 'mfa_setup_required') redirect('/setup/two-factor');
  if (ctx.status === 'second_factor_required') redirect('/sign-in/passkey');
  if (ctx.status === 'company_blocked')
    redirect(`/choose-company?blocked=${ctx.reason}&company=${ctx.tenantId}`);
  redirect('/choose-company');
}
