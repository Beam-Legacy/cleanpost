import 'server-only';
import { cookies } from 'next/headers';
import { pendingTwoFactorUser, trustedDevicesAllowed } from '@cleanpost/auth';
import { authEnvSchema, parseEnv } from '@cleanpost/config';
import { getDb } from './server';

/**
 * A-02: may "Trust this device for 12 hours" be offered? Only when every company the person
 * between their password and their code works in allows trusted devices (S-12, DEC-34).
 */
export async function canTrustDevice(): Promise<boolean> {
  const jar = await cookies();
  const value = jar.get('__Secure-cleanpost.two_factor')?.value ?? jar.get('cleanpost.two_factor')?.value;
  const userId = await pendingTwoFactorUser(getDb(), value, parseEnv(authEnvSchema).BETTER_AUTH_SECRET);
  return userId ? trustedDevicesAllowed(getDb(), userId) : false;
}
