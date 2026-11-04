import { describe, expect, it } from 'vitest';
import {
  EnvError,
  baseEnvSchema,
  dbEnvSchema,
  inviteLinksShown,
  parseEnv,
  secondFactorSkipAllowed,
} from '../src';

describe('parseEnv', () => {
  it('applies defaults', () => {
    expect(parseEnv(baseEnvSchema, {})).toEqual({ NODE_ENV: 'development', LOG_LEVEL: 'info' });
  });

  it('names invalid keys without echoing values', () => {
    const secret = 'mysql://user:hunter2@host/db';
    try {
      parseEnv(dbEnvSchema, { DATABASE_URL: secret });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(EnvError);
      expect((e as EnvError).keys).toEqual(['DATABASE_URL']);
      expect((e as Error).message).not.toContain('hunter2');
    }
  });

  it('accepts postgres URLs', () => {
    const env = parseEnv(dbEnvSchema, { DATABASE_URL: 'postgres://a:b@localhost:5432/cleanpost' });
    expect(env.DATABASE_URL).toContain('localhost');
  });
});

describe('secondFactorSkipAllowed', () => {
  it('is off unless asked for', () => {
    expect(secondFactorSkipAllowed({})).toBe(false);
    expect(secondFactorSkipAllowed({ CLEANPOST_ENV: 'preview', PREVIEW_ALLOW_SKIP_2FA: 'true' })).toBe(true);
  });

  it('refuses to turn on in staging or production', () => {
    for (const env of ['staging', 'production']) {
      expect(() => secondFactorSkipAllowed({ CLEANPOST_ENV: env, PREVIEW_ALLOW_SKIP_2FA: 'true' })).toThrow(
        EnvError,
      );
    }
  });
});

describe('inviteLinksShown', () => {
  it('only in local or preview, and only with email off', () => {
    expect(inviteLinksShown({ CLEANPOST_ENV: 'preview', SMTP_HOST: 'log' })).toBe(true);
    expect(inviteLinksShown({ SMTP_HOST: 'log' })).toBe(true);
    expect(inviteLinksShown({ CLEANPOST_ENV: 'preview', SMTP_HOST: 'smtp.example.test' })).toBe(false);
    for (const env of ['staging', 'production'])
      expect(inviteLinksShown({ CLEANPOST_ENV: env, SMTP_HOST: 'log' })).toBe(false);
  });
});
