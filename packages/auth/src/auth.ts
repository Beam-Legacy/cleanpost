import { passkey } from '@better-auth/passkey';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { twoFactor } from 'better-auth/plugins/two-factor';
import { eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { Database } from '@cleanpost/db';
import { accounts, passkeys, sessions, twoFactors, users, verifications } from '@cleanpost/db';
import { accountLockedEmail, newSignInEmail, passwordResetEmail, type Mailer } from '@cleanpost/email';
import { createLogger } from '@cleanpost/log';
import { describeDevice, deviceKey } from './device';

const log = createLogger({ name: 'auth' });

/** Session limits from docs/11-security-hipaa.md. */
export const SESSION_IDLE_SECONDS = 15 * 60;
export const SESSION_ABSOLUTE_SECONDS = 12 * 60 * 60;
export const PASSWORD_MIN_LENGTH = 12;
/** A-08: lock after this many consecutive wrong passwords, for LOCK_MINUTES. */
export const MAX_FAILED_SIGN_INS = 5;
export const LOCK_MINUTES = 15;
export const ACCOUNT_LOCKED = 'ACCOUNT_LOCKED';

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
  const { db, mailer } = config;

  /** A-08: refuse sign-in while locked; count failures; lock and email at the limit. */
  const lockout = {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== '/sign-in/email') return;
      const email = String((ctx.body as { email?: unknown } | undefined)?.email ?? '').toLowerCase();
      const [u] = await db
        .select({ lockedUntil: users.lockedUntil })
        .from(users)
        .where(eq(users.email, email));
      if (u?.lockedUntil && u.lockedUntil > new Date()) {
        throw new APIError('FORBIDDEN', { message: 'Account temporarily locked', code: ACCOUNT_LOCKED });
      }
    }),
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== '/sign-in/email') return;
      const email = String((ctx.body as { email?: unknown } | undefined)?.email ?? '').toLowerCase();
      if (!email) return;
      if (ctx.context.returned instanceof APIError) {
        const [u] = await db
          .update(users)
          .set({
            failedSignInCount: sql`${users.failedSignInCount} + 1`,
            lockedUntil: sql`case when ${users.failedSignInCount} + 1 >= ${MAX_FAILED_SIGN_INS}
              then now() + make_interval(mins => ${LOCK_MINUTES}) else ${users.lockedUntil} end`,
          })
          .where(eq(users.email, email))
          .returning({ id: users.id, count: users.failedSignInCount, lockedUntil: users.lockedUntil });
        if (u && u.count === MAX_FAILED_SIGN_INS && u.lockedUntil) {
          log.warn({ userId: u.id }, 'account locked after failed sign-ins');
          await mailer.send(
            email,
            'E-03',
            accountLockedEmail({
              until: u.lockedUntil,
              timeZone,
              resetUrl: `${appUrl.origin}/forgot-password`,
            }),
          );
        }
      } else {
        await db.update(users).set({ failedSignInCount: 0, lockedUntil: null }).where(eq(users.email, email));
      }
    }),
  };

  /** E-03: email the user when a session starts on a device family they have not used before. */
  async function alertOnNewDevice(session: { userId: string; userAgent?: string | null; createdAt: Date }) {
    const key = deviceKey(session.userAgent);
    const [u] = await db
      .select({ email: users.email, knownDevices: users.knownDevices })
      .from(users)
      .where(eq(users.id, session.userId));
    if (!u || u.knownDevices.includes(key)) return;
    await db
      .update(users)
      .set({ knownDevices: [key, ...u.knownDevices].slice(0, 10) })
      .where(eq(users.id, session.userId));
    if (u.knownDevices.length === 0) return; // first ever sign-in: nothing to compare against
    await mailer.send(
      u.email,
      'E-03',
      newSignInEmail({
        device: describeDevice(session.userAgent),
        location: null,
        at: new Date(session.createdAt),
        timeZone,
        notMeUrl: `${appUrl.origin}/account`,
      }),
    );
  }

  return betterAuth({
    appName: 'Cleanpost',
    baseURL: config.appUrl,
    basePath: '/api/auth',
    secret: config.secret,
    trustedOrigins: [appUrl.origin],
    telemetry: { enabled: false },
    // better-auth's own messages go through the redacting logger, never straight to the console.
    logger: {
      log: (level, message) => log[level]({ source: 'better-auth' }, message),
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customRules: { '/sign-in/email': { window: 60, max: 10 }, '/two-factor/*': { window: 60, max: 10 } },
    },
    hooks: lockout,
    databaseHooks: {
      session: {
        create: {
          after: async (session) => {
            await alertOnNewDevice(session).catch((err: unknown) =>
              log.error({ err }, 'new device alert failed'),
            );
          },
        },
      },
    },
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
