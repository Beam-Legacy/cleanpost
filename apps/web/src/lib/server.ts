import 'server-only';
import { z } from 'zod';
import { createAuth, type Auth } from '@cleanpost/auth';
import { authEnvSchema, dbEnvSchema, emailEnvSchema, parseEnv } from '@cleanpost/config';
import { getDatabase, type Database } from '@cleanpost/db';
import { createSmtpMailer, type Mailer } from '@cleanpost/email';

/** Process-wide singletons for server code. Each validates its own env on first use. */
let auth: Auth | undefined;
let mailer: Mailer | undefined;

export function getDb(): Database {
  parseEnv(dbEnvSchema);
  return getDatabase();
}

export function getMailer(): Mailer {
  mailer ??= createSmtpMailer(parseEnv(emailEnvSchema));
  return mailer;
}

export function getAuth(): Auth {
  if (!auth) {
    const env = parseEnv(authEnvSchema.extend({ NODE_ENV: z.string().default('development') }));
    auth = createAuth({
      db: getDb(),
      mailer: getMailer(),
      secret: env.BETTER_AUTH_SECRET,
      appUrl: env.APP_URL,
      production: env.NODE_ENV === 'production',
    });
  }
  return auth;
}
