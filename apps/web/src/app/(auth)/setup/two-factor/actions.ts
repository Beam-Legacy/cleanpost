'use server';
import { redirect } from 'next/navigation';
import { skipSecondFactorForSession } from '@cleanpost/auth';
import { safeNext } from '@/lib/next-path';
import { getDb } from '@/lib/server';
import { getContext } from '@/lib/session';

/** Preview only: continue this session without two-factor (refused outside preview by the auth module). */
export async function skipSecondFactorAction(formData: FormData) {
  const next = safeNext(formData.get('next')?.toString());
  const ctx = await getContext();
  if (ctx.status !== 'mfa_setup_required') redirect(next);
  await skipSecondFactorForSession(getDb(), ctx.sessionId);
  redirect(next);
}
