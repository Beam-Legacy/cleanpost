import { passkey } from '@better-auth/passkey';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { twoFactor } from 'better-auth/plugins/two-factor';
import { v7 as uuidv7 } from 'uuid';
import type { Database } from '@cleanpost/db';
import { accounts, passkeys, sessions, twoFactors, users, verifications } from '@cleanpost/db';
import { passwordResetEmail, type Mailer } from '@cleanpost/email';

/** Session limits from docs/11-security-hipaa.md. */
export const SESSION_IDLE_SECONDS = 15 * 60;
export const SESSION_ABSOLUTE_SECONDS = 12 * 60 * 60;
export const PASSWORD_MIN_LENGTH = 12;

export interface AuthConfig {
  db: Database;
  mailer: Mailer;
  secret: string;
  /** Public origin of the web app, e.g. https://app.cleanpost.example */
  appUrl: string;
  /** Time zone for times in emails until a user's own zone is known. */
  timeZone?: string;
  production?: boolean;
}

/**
 * better-auth configured for Cleanpost:
 * - no public sign-up: people join through invites (A-06);
 * - email and password, then a second factor (TOTP or passkey) that the app requires (A-02, A-03);
 * - sessions expire after 15 idle minutes (each use extends them); the 12-hour absolute limit is
 *   enforced in getSessionContext();
 * - better-auth's own telemetry is off.
 */
export function createAuth(config: AuthConfig) {
  const appUrl = new URL(config.appUrl);
  const timeZone = config.timeZone ?? 'America/Los_Angeles';
  return betterAuth({
    appName: 'Cleanpost',
    baseURL: config.appUrl,
    basePath: '/api/auth',
    secret: config.secret,
    trustedOrigins: [appUrl.origin],
    telemetry: { enabled: false },
    database: drizzleAdapter(config.db, {
      provider: 'pg',
      schema: {
        user: users,
        session: sessions,
        account: accounts,
        verification: verifications,
        twoFactor: twoFactors,
        passkey: passkeys,
      },
    }),
    advanced: {
      cookiePrefix: 'cleanpost',
      useSecureCookies: config.production ?? false,
      database: { generateId: () => uuidv7() },
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: 30 * 60,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        await config.mailer.send(
          user.email,
          'E-02',
          passwordResetEmail({ url, requestedAt: new Date(), timeZone }),
        );
      },
    },
    session: {
      expiresIn: SESSION_IDLE_SECONDS,
      updateAge: 60,
      freshAge: 5 * 60,
      additionalFields: {
        activeTenantId: { type: 'string', required: false, input: false },
      },
    },
    user: {
      additionalFields: {
        status: { type: 'string', required: false, input: false, defaultValue: 'active' },
      },
    },
    plugins: [
      twoFactor({ issuer: 'Cleanpost', backupCodeOptions: { amount: 10 } }),
      passkey({ rpID: appUrl.hostname, rpName: 'Cleanpost', origin: appUrl.origin }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
