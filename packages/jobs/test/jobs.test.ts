import { describe, expect, it } from 'vitest';
import { JOBS, QUEUES, syncPullPayload } from '../src';

describe('job payloads', () => {
  it('carry IDs only', () => {
    const ok = {
      tenantId: '01a00000-0000-7000-8000-000000000001',
      connectionId: '01a00000-0000-7000-8000-0000000000c1',
      trigger: 'manual',
    };
    expect(syncPullPayload.parse(ok)).toEqual(ok);
    expect(syncPullPayload.safeParse({ ...ok, connectionId: 'Lakeside' }).success).toBe(false);
    // Unknown keys are dropped, so nothing else rides along in a payload.
    expect(syncPullPayload.parse({ ...ok, patientName: 'x' })).not.toHaveProperty('patientName');
  });
});

describe('queues', () => {
  it('retry sync.pull 5 times with backoff, then dead-letter it (docs/01-architecture.md)', () => {
    const pull = QUEUES.find((q) => q.name === JOBS.syncPull)!;
    expect(pull.options).toMatchObject({
      retryLimit: 4,
      retryBackoff: true,
      deadLetter: JOBS.deadLetter,
      policy: 'stately',
    });
    expect(QUEUES.map((q) => q.name)).toContain(JOBS.deadLetter);
  });
});
