import { Writable } from 'node:stream';
import { scanForPhi, syntheticMemberId } from '@cleanpost/testing';
import { describe, expect, it } from 'vitest';
import { REDACTED, createLogger, log } from '../src';

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { lines, logger: createLogger({ name: 'test', level: 'debug', destination: stream }) };
}

describe('createLogger', () => {
  it('redacts PHI keys at any depth and keeps IDs', () => {
    const { lines, logger } = capture();
    logger.info(
      {
        claimId: '0192f3a0-7c1e-7000-8000-000000000001',
        patient: { firstName: 'Mai', lastName: 'Nguyen' },
        coverage: { member_id: syntheticMemberId(7), payer: 'Aetna' },
        nested: [{ deeper: { DOB: '1984-03-12' } }],
      },
      'claim built',
    );
    const entry = JSON.parse(lines[0]!);
    expect(entry.claimId).toBe('0192f3a0-7c1e-7000-8000-000000000001');
    expect(entry.patient).toBe(REDACTED);
    expect(entry.coverage.member_id).toBe(REDACTED);
    expect(entry.coverage.payer).toBe('Aetna');
    expect(entry.nested[0].deeper.DOB).toBe(REDACTED);
    expect(scanForPhi(lines.join(''))).toEqual([]);
  });

  it('does not log driver error messages, which can contain row values', () => {
    const { lines, logger } = capture();
    const dbError = Object.assign(new Error('duplicate key value: (lastName)=(Nguyen)'), {
      code: '23505',
      detail: 'Key (last_name)=(Nguyen) already exists.',
    });
    logger.error({ err: dbError }, 'insert failed');
    const entry = JSON.parse(lines[0]!);
    expect(entry.err.code).toBe('23505');
    expect(entry.err.message).toBe(REDACTED);
    expect(scanForPhi(lines.join(''))).toEqual([]);
  });

  it('sanitizes errors under any key and when passed directly', () => {
    const { lines, logger } = capture();
    const dbError = Object.assign(new Error('value (Okafor) too long'), { detail: 'Failing row (Okafor)' });
    logger.error({ failure: dbError }, 'insert failed');
    logger.error(dbError, 'insert failed');
    expect(scanForPhi(lines.join(''))).toEqual([]);
    expect(JSON.parse(lines[0]!).failure.message).toBe(REDACTED);
  });

  it('keeps messages of errors raised by our code', () => {
    const { lines, logger } = capture();
    logger.warn({ err: new Error('Connection paused by admin') }, 'sync skipped');
    expect(JSON.parse(lines[0]!).err.message).toBe('Connection paused by admin');
  });

  it('writes to the test log file through the default logger', () => {
    // Exercises CLEANPOST_LOG_FILE so the post-run scan has real output to check.
    log.info({ connectionId: 'c-1', patient: { lastName: 'Rivera' } }, 'sync finished');
    expect(process.env.CLEANPOST_LOG_FILE).toMatch(/test-logs/);
  });
});
