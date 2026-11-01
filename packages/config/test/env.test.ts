import { describe, expect, it } from 'vitest';
import { EnvError, baseEnvSchema, dbEnvSchema, parseEnv } from '../src';

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
