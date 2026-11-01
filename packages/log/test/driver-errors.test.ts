/**
 * Regression: Drizzle's query errors put the SQL parameters in a multi-line message, which also
 * appears at the top of `stack`, and carry `query`/`params` properties plus a `cause`. None of the
 * parameter values may reach the log, whichever way the error is logged.
 */
import { Writable } from 'node:stream';
import { scanForPhi, syntheticMemberId } from '@cleanpost/testing';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src';

class DrizzleQueryError extends Error {
  constructor(
    public query: string,
    public params: unknown[],
    cause?: unknown,
  ) {
    super(`Failed query: ${query}\nparams: ${params.join(',')}`, { cause });
    this.name = 'DrizzleQueryError';
  }
}

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { lines, logger: createLogger({ name: 'test', destination: stream }) };
}

const params = ['Nguyen', 'Mai', '1984-03-12', syntheticMemberId(9)];
const makeError = () =>
  new DrizzleQueryError(
    'insert into patients (last_name, first_name, dob, member_id) values ($1, $2, $3, $4)',
    params,
    Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }),
  );

describe('database driver errors', () => {
  it('leave no parameter values in the log, under err', () => {
    const { lines, logger } = capture();
    logger.error({ err: makeError() }, 'seed failed');
    expect(scanForPhi(lines.join(''))).toEqual([]);
    const entry = JSON.parse(lines[0]!);
    expect(entry.err.type).toBe('DrizzleQueryError');
    expect(entry.err.stack).toMatch(/^\s+at /);
    expect(entry.err.cause.code).toBe('ECONNREFUSED');
  });

  it('leave no parameter values when passed directly or under another key', () => {
    const { lines, logger } = capture();
    logger.error(makeError(), 'seed failed');
    logger.error({ failure: makeError() }, 'seed failed');
    logger.error({ nested: { deeper: makeError() } }, 'seed failed');
    expect(scanForPhi(lines.join(''))).toEqual([]);
  });
});
