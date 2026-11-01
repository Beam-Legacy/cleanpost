import { z } from 'zod';

/**
 * Environment schemas, one per concern, so each package validates only what it uses.
 * Error messages name the missing or invalid keys, never their values.
 */
export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

const postgresUrl = z.url({ protocol: /^postgres(ql)?$/ });

export const dbEnvSchema = z.object({
  /** Login used by the apps; never the table owner, so RLS always applies. */
  DATABASE_URL: postgresUrl,
  /** Owner login for migrations and the system role only. */
  DATABASE_ADMIN_URL: postgresUrl.optional(),
});

export const authEnvSchema = z.object({
  BETTER_AUTH_SECRET: z.string().min(32),
  APP_URL: z.url(),
});

export const emailEnvSchema = z.object({
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().positive(),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  EMAIL_FROM: z.string().min(3),
});

export class EnvError extends Error {
  constructor(readonly keys: string[]) {
    super(`Invalid or missing environment variables: ${keys.join(', ')}`);
    this.name = 'EnvError';
  }
}

export function parseEnv<S extends z.ZodType>(
  schema: S,
  source: Record<string, string | undefined> = process.env,
): z.infer<S> {
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new EnvError([...new Set(result.error.issues.map((i) => String(i.path[0] ?? '?')))]);
  }
  return result.data;
}
